/*
 * Copyright (c) 2018, 2020, Oracle and/or its affiliates. All rights reserved.
 * DO NOT ALTER OR REMOVE COPYRIGHT NOTICES OR THIS FILE HEADER.
 *
 * The Universal Permissive License (UPL), Version 1.0
 *
 * Subject to the condition set forth below, permission is hereby granted to any
 * person obtaining a copy of this software, associated documentation and/or
 * data (collectively the "Software"), free of charge and under any and all
 * copyright rights in the Software, and any and all patent rights owned or
 * freely licensable by each licensor hereunder covering either (i) the
 * unmodified Software as contributed to or provided by such licensor, or (ii)
 * the Larger Works (as defined below), to deal in both
 *
 * (a) the Software, and
 *
 * (b) any piece of software and/or hardware listed in the lrgrwrks.txt file if
 * one is included with the Software each a "Larger Work" to which the Software
 * is contributed by such licensors),
 *
 * without restriction, including without limitation the rights to copy, create
 * derivative works of, display, perform, and distribute the Software and make,
 * use, sell, offer for sale, import, export, have made, and have sold the
 * Software and the Larger Work(s), and to sublicense the foregoing rights on
 * either these or other terms.
 *
 * This license is subject to the following condition:
 *
 * The above copyright notice and either this complete permission notice or at a
 * minimum a reference to the UPL must be included in all copies or substantial
 * portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
package com.oracle.truffle.js.test.instrumentation.sourcesections;

import java.io.File;
import java.io.IOException;

import org.graalvm.polyglot.Context;
import org.graalvm.polyglot.Source;

import com.oracle.truffle.api.frame.VirtualFrame;
import com.oracle.truffle.api.instrumentation.EventContext;
import com.oracle.truffle.api.instrumentation.ExecutionEventListener;
import com.oracle.truffle.api.instrumentation.SourceSectionFilter;
import com.oracle.truffle.api.instrumentation.StandardTags.ExpressionTag;
import com.oracle.truffle.api.instrumentation.TruffleInstrument;
import com.oracle.truffle.api.instrumentation.TruffleInstrument.Registration;
import com.oracle.truffle.js.test.instrumentation.TestUtil;

/**
 * Utility instrument tracing expressions in Graal.js.
 */
@Registration(id = ExpressionsSourceSectionDumpInstrument.ID, services = {ExpressionsSourceSectionDumpInstrument.class})
public class ExpressionsSourceSectionDumpInstrument extends TruffleInstrument {

    public static final String ID = "ExpressionsSourceSectionDumpInstrument";

    private Env environment;

    public static void main(String[] args) throws IOException {
        try (Context c = TestUtil.newContextBuilder().build()) {
            c.getEngine().getInstruments().get(ID).lookup(ExpressionsSourceSectionDumpInstrument.class);
            c.eval(Source.newBuilder("js", new File(args[0])).build());
        }
    }

    @Override
    protected void onCreate(Env env) {
        this.environment = env;
        env.registerService(this);
        SourceSectionFilter sourceSectionFilter = SourceSectionFilter.newBuilder().tagIs(ExpressionTag.class).build();
        env.getInstrumenter().attachExecutionEventListener(sourceSectionFilter, getFactory());
    }

    private static ExecutionEventListener getFactory() {
        return new ExecutionEventListener() {
            @Override
            public void onReturnValue(EventContext cx, VirtualFrame frame, Object result) {
            }

            @Override
            public void onReturnExceptional(EventContext cx, VirtualFrame frame, Throwable exception) {
            }

            @Override
            public void onEnter(EventContext cx, VirtualFrame frame) {
                System.out.println(cx.getInstrumentedSourceSection().getCharacters());
            }
        };
    }

    public Env getEnvironment() {
        return this.environment;
    }
}
