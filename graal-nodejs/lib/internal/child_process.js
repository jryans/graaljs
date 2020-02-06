'use strict';

const { JSON, Object } = primordials;

const {
  errnoException,
  codes: {
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_HANDLE_TYPE,
    ERR_INVALID_OPT_VALUE,
    ERR_INVALID_SYNC_FORK_INPUT,
    ERR_IPC_CHANNEL_CLOSED,
    ERR_IPC_DISCONNECTED,
    ERR_IPC_ONE_PIPE,
    ERR_IPC_SYNC_FORK,
    ERR_MISSING_ARGS
  }
} = require('internal/errors');
const { validateString } = require('internal/validators');
const EventEmitter = require('events');
const net = require('net');
const dgram = require('dgram');
const inspect = require('internal/util/inspect').inspect;
const assert = require('internal/assert');

const { Process } = internalBinding('process_wrap');
const {
  WriteWrap,
  kReadBytesOrError,
  kArrayBufferOffset,
  kLastWriteWasAsync,
  streamBaseState
} = internalBinding('stream_wrap');
const { Pipe, constants: PipeConstants } = internalBinding('pipe_wrap');
const { TCP } = internalBinding('tcp_wrap');
const { TTY } = internalBinding('tty_wrap');
const { UDP } = internalBinding('udp_wrap');
const SocketList = require('internal/socket_list');
const { owner_symbol } = require('internal/async_hooks').symbols;
const { convertToValidSignal } = require('internal/util');
const { isArrayBufferView } = require('internal/util/types');
const spawn_sync = internalBinding('spawn_sync');
const { kStateSymbol } = require('internal/dgram');

const {
  UV_EACCES,
  UV_EAGAIN,
  UV_EINVAL,
  UV_EMFILE,
  UV_ENFILE,
  UV_ENOENT,
  UV_ENOSYS,
  UV_ESRCH
} = internalBinding('uv');

const { SocketListSend, SocketListReceive } = SocketList;

// Lazy loaded for startup performance.
let StringDecoder;
// Lazy loaded for startup performance and to allow monkey patching of
// internalBinding('http_parser').HTTPParser.
let freeParser;
let HTTPParser;

const MAX_HANDLE_RETRANSMISSIONS = 3;
const kIsUsedAsStdio = Symbol('kIsUsedAsStdio');

// This object contain function to convert TCP objects to native handle objects
// and back again.
const handleConversion = {
  'net.Native': {
    simultaneousAccepts: true,

    send(message, handle, options) {
      return handle;
    },

    got(message, handle, emit) {
      emit(handle);
    }
  },

  'net.Server': {
    simultaneousAccepts: true,

    send(message, server, options) {
      return server._handle;
    },

    got(message, handle, emit) {
      const server = new net.Server();
      server.listen(handle, () => {
        emit(server);
      });
    }
  },

  'net.Socket': {
    send(message, socket, options) {
      if (!socket._handle)
        return;

      // If the socket was created by net.Server
      if (socket.server) {
        // The worker should keep track of the socket
        message.key = socket.server._connectionKey;

        const firstTime = !this.channel.sockets.send[message.key];
        const socketList = getSocketList('send', this, message.key);

        // The server should no longer expose a .connection property
        // and when asked to close it should query the socket status from
        // the workers
        if (firstTime) socket.server._setupWorker(socketList);

        // Act like socket is detached
        if (!options.keepOpen)
          socket.server._connections--;
      }

      const handle = socket._handle;

      // Remove handle from socket object, it will be closed when the socket
      // will be sent
      if (!options.keepOpen) {
        handle.onread = nop;
        socket._handle = null;
        socket.setTimeout(0);

        if (freeParser === undefined)
          freeParser = require('_http_common').freeParser;
        if (HTTPParser === undefined)
          HTTPParser = require('_http_common').HTTPParser;

        // In case of an HTTP connection socket, release the associated
        // resources
        if (socket.parser && socket.parser instanceof HTTPParser) {
          freeParser(socket.parser, null, socket);
          if (socket._httpMessage)
            socket._httpMessage.detachSocket(socket);
        }
      }

      return handle;
    },

    postSend(message, handle, options, callback, target) {
      // Store the handle after successfully sending it, so it can be closed
      // when the NODE_HANDLE_ACK is received. If the handle could not be sent,
      // just close it.
      if (handle && !options.keepOpen) {
        if (target) {
          // There can only be one _pendingMessage as passing handles are
          // processed one at a time: handles are stored in _handleQueue while
          // waiting for the NODE_HANDLE_ACK of the current passing handle.
          assert(!target._pendingMessage);
          target._pendingMessage =
              { callback, message, handle, options, retransmissions: 0 };
        } else {
          handle.close();
        }
      }
    },

    got(message, handle, emit) {
      const socket = new net.Socket({
        handle: handle,
        readable: true,
        writable: true
      });

      // If the socket was created by net.Server we will track the socket
      if (message.key) {

        // Add socket to connections list
        const socketList = getSocketList('got', this, message.key);
        socketList.add({
          socket: socket
        });
      }

      emit(socket);
    }
  },

  'dgram.Native': {
    simultaneousAccepts: false,

    send(message, handle, options) {
      return handle;
    },

    got(message, handle, emit) {
      emit(handle);
    }
  },

  'dgram.Socket': {
    simultaneousAccepts: false,

    send(message, socket, options) {
      message.dgramType = socket.type;

      return socket[kStateSymbol].handle;
    },

    got(message, handle, emit) {
      const socket = new dgram.Socket(message.dgramType);

      socket.bind(handle, () => {
        emit(socket);
      });
    }
  }
};

function stdioStringToArray(stdio, channel) {
  const options = [];

  switch (stdio) {
    case 'ignore':
    case 'pipe': options.push(stdio, stdio, stdio); break;
    case 'inherit': options.push(0, 1, 2); break;
    default:
      throw new ERR_INVALID_OPT_VALUE('stdio', stdio);
  }

  if (channel) options.push(channel);

  return options;
}

function ChildProcess() {
  EventEmitter.call(this);

  this._closesNeeded = 1;
  this._closesGot = 0;
  this.connected = false;

  this.signalCode = null;
  this.exitCode = null;
  this.killed = false;
  this.spawnfile = null;

  this._handle = new Process();
  this._handle[owner_symbol] = this;

  this._handle.onexit = (exitCode, signalCode) => {
    if (signalCode) {
      this.signalCode = signalCode;
    } else {
      this.exitCode = exitCode;
    }

    if (this.stdin) {
      this.stdin.destroy();
    }

    this._handle.close();
    this._handle = null;

    if (exitCode < 0) {
      const syscall = this.spawnfile ? 'spawn ' + this.spawnfile : 'spawn';
      const err = errnoException(exitCode, syscall);

      if (this.spawnfile)
        err.path = this.spawnfile;

      err.spawnargs = this.spawnargs.slice(1);
      this.emit('error', err);
    } else {
      this.emit('exit', this.exitCode, this.signalCode);
    }

    // If any of the stdio streams have not been touched,
    // then pull all the data through so that it can get the
    // eof and emit a 'close' event.
    // Do it on nextTick so that the user has one last chance
    // to consume the output, if for example they only want to
    // start reading the data once the process exits.
    process.nextTick(flushStdio, this);

    maybeClose(this);
  };
}
Object.setPrototypeOf(ChildProcess.prototype, EventEmitter.prototype);
Object.setPrototypeOf(ChildProcess, EventEmitter);


function flushStdio(subprocess) {
  const stdio = subprocess.stdio;

  if (stdio == null) return;

  for (let i = 0; i < stdio.length; i++) {
    const stream = stdio[i];
    // TODO(addaleax): This doesn't necessarily account for all the ways in
    // which data can be read from a stream, e.g. being consumed on the
    // native layer directly as a StreamBase.
    if (!stream || !stream.readable ||
        stream._readableState.readableListening ||
        stream[kIsUsedAsStdio]) {
      continue;
    }
    stream.resume();
  }
}


function createSocket(pipe, readable) {
  return net.Socket({ handle: pipe, readable, writable: !readable });
}


function getHandleWrapType(stream) {
  if (stream instanceof Pipe) return 'pipe';
  if (stream instanceof TTY) return 'tty';
  if (stream instanceof TCP) return 'tcp';
  if (stream instanceof UDP) return 'udp';

  return false;
}

function closePendingHandle(target) {
  target._pendingMessage.handle.close();
  target._pendingMessage = null;
}


ChildProcess.prototype.spawn = function(options) {
  let i = 0;

  if (options === null || typeof options !== 'object') {
    throw new ERR_INVALID_ARG_TYPE('options', 'Object', options);
  }

  // If no `stdio` option was given - use default
  let stdio = options.stdio || 'pipe';

  stdio = getValidStdio(stdio, false);

  const ipc = stdio.ipc;
  const ipcFd = stdio.ipcFd;
  stdio = options.stdio = stdio.stdio;

  if (ipc !== undefined) {
    // Let child process know about opened IPC channel
    if (options.envPairs === undefined)
      options.envPairs = [];
    else if (!Array.isArray(options.envPairs)) {
      throw new ERR_INVALID_ARG_TYPE('options.envPairs',
                                     'Array',
                                     options.envPairs);
    }

    options.envPairs.push('NODE_CHANNEL_FD=' + ipcFd);
  }

  validateString(options.file, 'options.file');
  this.spawnfile = options.file;

  if (Array.isArray(options.args))
    this.spawnargs = options.args;
  else if (options.args === undefined)
    this.spawnargs = [];
  else
    throw new ERR_INVALID_ARG_TYPE('options.args', 'Array', options.args);

  // (db) we extend 'options' with info for thread-based spawn
  options.ipc = ipc;
  options.ipcFd = ipcFd;

  const err = this._handle.spawn(options);

  // Run-time errors should emit an error, not throw an exception.
  if (err === UV_EACCES ||
      err === UV_EAGAIN ||
      err === UV_EMFILE ||
      err === UV_ENFILE ||
      err === UV_ENOENT) {
    process.nextTick(onErrorNT, this, err);

    // There is no point in continuing when we've hit EMFILE or ENFILE
    // because we won't be able to set up the stdio file descriptors.
    if (err === UV_EMFILE || err === UV_ENFILE)
      return err;
  } else if (err) {
    // Close all opened fds on error
    for (i = 0; i < stdio.length; i++) {
      const stream = stdio[i];
      if (stream.type === 'pipe') {
        stream.handle.close();
      }
    }

    this._handle.close();
    this._handle = null;
    throw errnoException(err, 'spawn');
  }

  this.pid = this._handle.pid;

  for (i = 0; i < stdio.length; i++) {
    const stream = stdio[i];
    if (stream.type === 'ignore') continue;

    if (stream.ipc) {
      this._closesNeeded++;
      continue;
    }

    // The stream is already cloned and piped, thus stop its readable side,
    // otherwise we might attempt to read from the stream when at the same time
    // the child process does.
    if (stream.type === 'wrap') {
      stream.handle.reading = false;
      stream.handle.readStop();
      stream._stdio.pause();
      stream._stdio.readableFlowing = false;
      stream._stdio._readableState.reading = false;
      stream._stdio[kIsUsedAsStdio] = true;
      continue;
    }

    if (stream.handle) {
      // When i === 0 - we're dealing with stdin
      // (which is the only one writable pipe).
      stream.socket = createSocket(this.pid !== 0 ?
        stream.handle : null, i > 0);

      if (i > 0 && this.pid !== 0) {
        this._closesNeeded++;
        stream.socket.on('close', () => {
          maybeClose(this);
        });
      }
    }
  }

  this.stdin = stdio.length >= 1 && stdio[0].socket !== undefined ?
    stdio[0].socket : null;
  this.stdout = stdio.length >= 2 && stdio[1].socket !== undefined ?
    stdio[1].socket : null;
  this.stderr = stdio.length >= 3 && stdio[2].socket !== undefined ?
    stdio[2].socket : null;

  this.stdio = [];

  for (i = 0; i < stdio.length; i++)
    this.stdio.push(stdio[i].socket === undefined ? null : stdio[i].socket);

  // Add .send() method and start listening for IPC data
  if (ipc !== undefined) setupChannel(this, ipc);

  return err;
};


function onErrorNT(self, err) {
  self._handle.onexit(err);
}


ChildProcess.prototype.kill = function(sig) {

  const signal = sig === 0 ? sig :
    convertToValidSignal(sig === undefined ? 'SIGTERM' : sig);

  if (this._handle) {
    const err = this._handle.kill(signal);
    if (err === 0) {
      /* Success. */
      this.killed = true;
      return true;
    }
    if (err === UV_ESRCH) {
      /* Already dead. */
    } else if (err === UV_EINVAL || err === UV_ENOSYS) {
      /* The underlying platform doesn't support this signal. */
      throw errnoException(err, 'kill');
    } else {
      /* Other error, almost certainly EPERM. */
      this.emit('error', errnoException(err, 'kill'));
    }
  }

  /* Kill didn't succeed. */
  return false;
};


ChildProcess.prototype.ref = function() {
  if (this._handle) this._handle.ref();
};


ChildProcess.prototype.unref = function() {
  if (this._handle) this._handle.unref();
};

class Control extends EventEmitter {
  constructor(channel) {
    super();
    this.channel = channel;
    this.refs = 0;
  }
  ref() {
    if (++this.refs === 1) {
      this.channel.ref();
    }
  }
  unref() {
    if (--this.refs === 0) {
      this.channel.unref();
      this.emit('unref');
    }
  }
}

function setupChannel(target, channel) {
  target.channel = channel;

  // _channel can be deprecated in version 8
  Object.defineProperty(target, '_channel', {
    get() { return target.channel; },
    set(val) { target.channel = val; },
    enumerable: true
  });

  target._handleQueue = null;
  target._pendingMessage = null;

  const control = new Control(channel);

  if (StringDecoder === undefined)
    StringDecoder = require('string_decoder').StringDecoder;
  const decoder = new StringDecoder('utf8');
  var jsonBuffer = '';
  var pendingHandle = null;
  channel.buffering = false;
  channel.pendingHandle = null;
  channel.onread = function(arrayBuffer) {
    const recvHandle = channel.pendingHandle;
    channel.pendingHandle = null;
    if (arrayBuffer) {
      const nread = streamBaseState[kReadBytesOrError];
      const offset = streamBaseState[kArrayBufferOffset];
      const pool = new Uint8Array(arrayBuffer, offset, nread);
      if (recvHandle)
        pendingHandle = recvHandle;

      // Linebreak is used as a message end sign
      var chunks = decoder.write(pool).split('\n');
      var numCompleteChunks = chunks.length - 1;
      // Last line does not have trailing linebreak
      var incompleteChunk = chunks[numCompleteChunks];
      if (numCompleteChunks === 0) {
        jsonBuffer += incompleteChunk;
        this.buffering = jsonBuffer.length !== 0;
        return;
      }
      chunks[0] = jsonBuffer + chunks[0];

      for (var i = 0; i < numCompleteChunks; i++) {
        var message = JSON.parse(chunks[i]);

        // There will be at most one NODE_HANDLE message in every chunk we
        // read because SCM_RIGHTS messages don't get coalesced. Make sure
        // that we deliver the handle with the right message however.
        if (isInternal(message)) {
          if (message.cmd === 'NODE_HANDLE') {
            handleMessage(message, pendingHandle, true);
            pendingHandle = null;
          } else {
            handleMessage(message, undefined, true);
          }
        } else {
          handleMessage(message, undefined, false);
        }
      }
      jsonBuffer = incompleteChunk;
      this.buffering = jsonBuffer.length !== 0;

    } else {
      this.buffering = false;
      target.disconnect();
      channel.onread = nop;
      channel.close();
      target.channel = null;
      maybeClose(target);
    }
  };

  // Object where socket lists will live
  channel.sockets = { got: {}, send: {} };

  // Handlers will go through this
  target.on('internalMessage', function(message, handle) {
    // Once acknowledged - continue sending handles.
    if (message.cmd === 'NODE_HANDLE_ACK' ||
        message.cmd === 'NODE_HANDLE_NACK') {

      if (target._pendingMessage) {
        if (message.cmd === 'NODE_HANDLE_ACK') {
          closePendingHandle(target);
        } else if (target._pendingMessage.retransmissions++ ===
                   MAX_HANDLE_RETRANSMISSIONS) {
          closePendingHandle(target);
          process.emitWarning('Handle did not reach the receiving process ' +
                              'correctly', 'SentHandleNotReceivedWarning');
        }
      }

      assert(Array.isArray(target._handleQueue));
      const queue = target._handleQueue;
      target._handleQueue = null;

      if (target._pendingMessage) {
        target._send(target._pendingMessage.message,
                     target._pendingMessage.handle,
                     target._pendingMessage.options,
                     target._pendingMessage.callback);
      }

      for (let i = 0; i < queue.length; i++) {
        const args = queue[i];
        target._send(args.message, args.handle, args.options, args.callback);
      }

      // Process a pending disconnect (if any).
      if (!target.connected && target.channel && !target._handleQueue)
        target._disconnect();

      return;
    }

    if (message.cmd !== 'NODE_HANDLE') return;

    // It is possible that the handle is not received because of some error on
    // ancillary data reception such as MSG_CTRUNC. In this case, report the
    // sender about it by sending a NODE_HANDLE_NACK message.
    if (!handle)
      return target._send({ cmd: 'NODE_HANDLE_NACK' }, null, true);

    // Acknowledge handle receival. Don't emit error events (for example if
    // the other side has disconnected) because this call to send() is not
    // initiated by the user and it shouldn't be fatal to be unable to ACK
    // a message.
    target._send({ cmd: 'NODE_HANDLE_ACK' }, null, true);

    const obj = handleConversion[message.type];

    // Update simultaneous accepts on Windows
    if (process.platform === 'win32') {
      handle.setSimultaneousAccepts(false);
    }

    // Convert handle object
    obj.got.call(this, message, handle, (handle) => {
      handleMessage(message.msg, handle, isInternal(message.msg));
    });
  });

  target.send = function(message, handle, options, callback) {
    if (typeof handle === 'function') {
      callback = handle;
      handle = undefined;
      options = undefined;
    } else if (typeof options === 'function') {
      callback = options;
      options = undefined;
    } else if (options !== undefined &&
               (options === null || typeof options !== 'object')) {
      throw new ERR_INVALID_ARG_TYPE('options', 'Object', options);
    }

    options = { swallowErrors: false, ...options };

    if (this.connected) {
      return this._send(message, handle, options, callback);
    }
    const ex = new ERR_IPC_CHANNEL_CLOSED();
    if (typeof callback === 'function') {
      process.nextTick(callback, ex);
    } else {
      process.nextTick(() => this.emit('error', ex));
    }
    return false;
  };

  target._send = function(message, handle, options, callback) {
    assert(this.connected || this.channel);

    if (message === undefined)
      throw new ERR_MISSING_ARGS('message');

    // Non-serializable messages should not reach the remote
    // end point; as any failure in the stringification there
    // will result in error message that is weakly consumable.
    // So perform a sanity check on message prior to sending.
    if (typeof message !== 'string' &&
        typeof message !== 'object' &&
        typeof message !== 'number' &&
        typeof message !== 'boolean') {
      throw new ERR_INVALID_ARG_TYPE(
        'message', ['string', 'object', 'number', 'boolean'], message);
    }

    // Support legacy function signature
    if (typeof options === 'boolean') {
      options = { swallowErrors: options };
    }

    let obj;

    // Package messages with a handle object
    if (handle) {
      // This message will be handled by an internalMessage event handler
      message = {
        cmd: 'NODE_HANDLE',
        type: null,
        msg: message
      };

      if (handle instanceof net.Socket) {
        message.type = 'net.Socket';
      } else if (handle instanceof net.Server) {
        message.type = 'net.Server';
      } else if (handle instanceof TCP || handle instanceof Pipe) {
        message.type = 'net.Native';
      } else if (handle instanceof dgram.Socket) {
        message.type = 'dgram.Socket';
      } else if (handle instanceof UDP) {
        message.type = 'dgram.Native';
      } else {
        throw new ERR_INVALID_HANDLE_TYPE();
      }

      // Queue-up message and handle if we haven't received ACK yet.
      if (this._handleQueue) {
        this._handleQueue.push({
          callback: callback,
          handle: handle,
          options: options,
          message: message.msg,
        });
        return this._handleQueue.length === 1;
      }

      obj = handleConversion[message.type];

      // convert TCP object to native handle object
      handle = handleConversion[message.type].send.call(target,
                                                        message,
                                                        handle,
                                                        options);

      // If handle was sent twice, or it is impossible to get native handle
      // out of it - just send a text without the handle.
      if (!handle)
        message = message.msg;

      // Update simultaneous accepts on Windows
      if (obj.simultaneousAccepts && process.platform === 'win32') {
        handle.setSimultaneousAccepts(true);
      }
    } else if (this._handleQueue &&
               !(message && (message.cmd === 'NODE_HANDLE_ACK' ||
                             message.cmd === 'NODE_HANDLE_NACK'))) {
      // Queue request anyway to avoid out-of-order messages.
      this._handleQueue.push({
        callback: callback,
        handle: null,
        options: options,
        message: message,
      });
      return this._handleQueue.length === 1;
    }

    const req = new WriteWrap();

    const string = JSON.stringify(message) + '\n';
    const err = channel.writeUtf8String(req, string, handle);
    const wasAsyncWrite = streamBaseState[kLastWriteWasAsync];

    if (err === 0) {
      if (handle) {
        if (!this._handleQueue)
          this._handleQueue = [];
        if (obj && obj.postSend)
          obj.postSend(message, handle, options, callback, target);
      }

      if (wasAsyncWrite) {
        req.oncomplete = () => {
          control.unref();
          if (typeof callback === 'function')
            callback(null);
        };
        control.ref();
      } else if (typeof callback === 'function') {
        process.nextTick(callback, null);
      }
    } else {
      // Cleanup handle on error
      if (obj && obj.postSend)
        obj.postSend(message, handle, options, callback);

      if (!options.swallowErrors) {
        const ex = errnoException(err, 'write');
        if (typeof callback === 'function') {
          process.nextTick(callback, ex);
        } else {
          process.nextTick(() => this.emit('error', ex));
        }
      }
    }

    /* If the master is > 2 read() calls behind, please stop sending. */
    return channel.writeQueueSize < (65536 * 2);
  };

  // Connected will be set to false immediately when a disconnect() is
  // requested, even though the channel might still be alive internally to
  // process queued messages. The three states are distinguished as follows:
  // - disconnect() never requested: channel is not null and connected
  //   is true
  // - disconnect() requested, messages in the queue: channel is not null
  //   and connected is false
  // - disconnect() requested, channel actually disconnected: channel is
  //   null and connected is false
  target.connected = true;

  target.disconnect = function() {
    if (!this.connected) {
      this.emit('error', new ERR_IPC_DISCONNECTED());
      return;
    }

    // Do not allow any new messages to be written.
    this.connected = false;

    // If there are no queued messages, disconnect immediately. Otherwise,
    // postpone the disconnect so that it happens internally after the
    // queue is flushed.
    if (!this._handleQueue)
      this._disconnect();
  };

  target._disconnect = function() {
    assert(this.channel);

    // This marks the fact that the channel is actually disconnected.
    this.channel = null;

    if (this._pendingMessage)
      closePendingHandle(this);

    let fired = false;
    function finish() {
      if (fired) return;
      fired = true;

      channel.close();
      target.emit('disconnect');
    }

    // If a message is being read, then wait for it to complete.
    if (channel.buffering) {
      this.once('message', finish);
      this.once('internalMessage', finish);

      return;
    }

    process.nextTick(finish);
  };

  function emit(event, message, handle) {
    target.emit(event, message, handle);
  }

  function handleMessage(message, handle, internal) {
    if (!target.channel)
      return;

    const eventName = (internal ? 'internalMessage' : 'message');

    process.nextTick(emit, eventName, message, handle);
  }

  channel.readStart();
  return control;
}

const INTERNAL_PREFIX = 'NODE_';
function isInternal(message) {
  return (message !== null &&
          typeof message === 'object' &&
          typeof message.cmd === 'string' &&
          message.cmd.length > INTERNAL_PREFIX.length &&
          message.cmd.slice(0, INTERNAL_PREFIX.length) === INTERNAL_PREFIX);
}

function nop() { }

function getValidStdio(stdio, sync) {
  let ipc;
  let ipcFd;

  // Replace shortcut with an array
  if (typeof stdio === 'string') {
    stdio = stdioStringToArray(stdio);
  } else if (!Array.isArray(stdio)) {
    throw new ERR_INVALID_OPT_VALUE('stdio', inspect(stdio));
  }

  // At least 3 stdio will be created
  // Don't concat() a new Array() because it would be sparse, and
  // stdio.reduce() would skip the sparse elements of stdio.
  // See http://stackoverflow.com/a/5501711/3561
  while (stdio.length < 3) stdio.push(undefined);

  // Translate stdio into C++-readable form
  // (i.e. PipeWraps or fds)
  stdio = stdio.reduce((acc, stdio, i) => {
    function cleanup() {
      for (let i = 0; i < acc.length; i++) {
        if ((acc[i].type === 'pipe' || acc[i].type === 'ipc') && acc[i].handle)
          acc[i].handle.close();
      }
    }

    // Defaults
    if (stdio == null) {
      stdio = i < 3 ? 'pipe' : 'ignore';
    }

    if (stdio === 'ignore') {
      acc.push({ type: 'ignore' });
    } else if (stdio === 'pipe' || (typeof stdio === 'number' && stdio < 0)) {
      const a = {
        type: 'pipe',
        readable: i === 0,
        writable: i !== 0
      };

      if (!sync)
        a.handle = new Pipe(PipeConstants.SOCKET);

      acc.push(a);
    } else if (stdio === 'ipc') {
      if (sync || ipc !== undefined) {
        // Cleanup previously created pipes
        cleanup();
        if (!sync)
          throw new ERR_IPC_ONE_PIPE();
        else
          throw new ERR_IPC_SYNC_FORK();
      }

      ipc = new Pipe(PipeConstants.IPC);
      ipcFd = i;

      acc.push({
        type: 'pipe',
        handle: ipc,
        ipc: true
      });
    } else if (stdio === 'inherit') {
      acc.push({
        type: 'inherit',
        fd: i
      });
    } else if (typeof stdio === 'number' || typeof stdio.fd === 'number') {
      acc.push({
        type: 'fd',
        fd: typeof stdio === 'number' ? stdio : stdio.fd
      });
    } else if (getHandleWrapType(stdio) || getHandleWrapType(stdio.handle) ||
               getHandleWrapType(stdio._handle)) {
      const handle = getHandleWrapType(stdio) ?
        stdio :
        getHandleWrapType(stdio.handle) ? stdio.handle : stdio._handle;

      acc.push({
        type: 'wrap',
        wrapType: getHandleWrapType(handle),
        handle: handle,
        _stdio: stdio
      });
    } else if (isArrayBufferView(stdio) || typeof stdio === 'string') {
      if (!sync) {
        cleanup();
        throw new ERR_INVALID_SYNC_FORK_INPUT(inspect(stdio));
      }
    } else {
      // Cleanup
      cleanup();
      throw new ERR_INVALID_OPT_VALUE('stdio', inspect(stdio));
    }

    return acc;
  }, []);

  return { stdio, ipc, ipcFd };
}


function getSocketList(type, worker, key) {
  const sockets = worker.channel.sockets[type];
  let socketList = sockets[key];
  if (!socketList) {
    const Construct = type === 'send' ? SocketListSend : SocketListReceive;
    socketList = sockets[key] = new Construct(worker, key);
  }
  return socketList;
}


function maybeClose(subprocess) {
  subprocess._closesGot++;

  if (subprocess._closesGot === subprocess._closesNeeded) {
    subprocess.emit('close', subprocess.exitCode, subprocess.signalCode);
  }
}

function spawnSync(opts) {
  const options = opts.options;
  const result = spawn_sync.spawn(options);

  if (result.output && options.encoding && options.encoding !== 'buffer') {
    for (let i = 0; i < result.output.length; i++) {
      if (!result.output[i])
        continue;
      result.output[i] = result.output[i].toString(options.encoding);
    }
  }

  result.stdout = result.output && result.output[1];
  result.stderr = result.output && result.output[2];

  if (result.error) {
    result.error = errnoException(result.error, 'spawnSync ' + opts.file);
    result.error.path = opts.file;
    result.error.spawnargs = opts.args.slice(1);
  }

  return result;
}

module.exports = {
  ChildProcess,
  setupChannel,
  getValidStdio,
  stdioStringToArray,
  spawnSync
};
