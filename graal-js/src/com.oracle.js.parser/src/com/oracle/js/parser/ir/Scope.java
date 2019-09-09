/*
 * Copyright (c) 2019, 2019, Oracle and/or its affiliates. All rights reserved.
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

package com.oracle.js.parser.ir;

import java.util.AbstractMap;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.StringJoiner;

import org.graalvm.collections.EconomicMap;

/**
 * Represents a binding scope (corresponds to LexicalEnvironment or VariableEnvironment).
 */
public final class Scope {
    private final Scope parent;
    private final int type;

    private static final int BLOCK_SCOPE = 1 << 0;
    private static final int FUNCTION_BODY_SCOPE = 1 << 1;
    private static final int FUNCTION_PARAMETER_SCOPE = 1 << 2;
    private static final int CATCH_PARAMETER_SCOPE = 1 << 3;
    private static final int GLOBAL_SCOPE = 1 << 4;
    private static final int MODULE_SCOPE = 1 << 5;
    private static final int FUNCTION_TOP_SCOPE = 1 << 6;

    /** Symbol table - keys must be returned in the order they were put in. */
    protected final EconomicMap<String, Symbol> symbols;
    protected List<Map.Entry<VarNode, Scope>> hoistedVarDeclarations;
    protected List<Map.Entry<VarNode, Scope>> hoistableBlockFunctionDeclarations;

    private int blockScopedOrRedeclaredSymbols;
    private int declaredNames;
    private boolean closed;

    private Scope(Scope parent, int type) {
        this.parent = parent;
        this.type = type | (isFunctionTopScope(type, parent) ? FUNCTION_TOP_SCOPE : 0);
        this.symbols = EconomicMap.create();
    }

    private static boolean isFunctionTopScope(int type, Scope parent) {
        return (type & FUNCTION_PARAMETER_SCOPE) != 0 || ((type & FUNCTION_BODY_SCOPE) != 0 && (parent == null || !parent.isFunctionParameterScope()));
    }

    public static Scope createGlobal() {
        return new Scope(null, FUNCTION_BODY_SCOPE | GLOBAL_SCOPE);
    }

    public static Scope createModule() {
        return new Scope(null, FUNCTION_BODY_SCOPE | MODULE_SCOPE);
    }

    public static Scope createFunctionBody(Scope parent) {
        return new Scope(parent, FUNCTION_BODY_SCOPE);
    }

    public static Scope createBlock(Scope parent) {
        return new Scope(parent, BLOCK_SCOPE);
    }

    public static Scope createCatch(Scope parent) {
        return new Scope(parent, CATCH_PARAMETER_SCOPE);
    }

    public static Scope createParameter(Scope parent) {
        return new Scope(parent, FUNCTION_PARAMETER_SCOPE);
    }

    public Scope getParent() {
        return parent;
    }

    /**
     * Get all the symbols defined in this block, in definition order.
     *
     * @return symbol iterator
     */
    public Iterable<Symbol> getSymbols() {
        return symbols.getValues();
    }

    /**
     * Retrieves an existing symbol defined in the current block.
     *
     * @param name the name of the symbol
     * @return an existing symbol with the specified name defined in the current block, or null if
     *         this block doesn't define a symbol with this name.
     */
    public Symbol getExistingSymbol(final String name) {
        return symbols.get(name);
    }

    /**
     * Test if a symbol with this name is defined in the current block.
     *
     * @param name the name of the symbol
     */
    public boolean hasSymbol(final String name) {
        return symbols.containsKey(name);
    }

    /**
     * Get the number of symbols defined in this block.
     */
    public int getSymbolCount() {
        return symbols.size();
    }

    /**
     * Add or overwrite an existing symbol in the block
     */
    public void putSymbol(final Symbol symbol) {
        assert !closed : "scope is closed";
        Symbol existing = symbols.put(symbol.getName(), symbol);
        if (existing != null) {
            assert (existing.getFlags() & Symbol.KINDMASK) == (symbol.getFlags() & Symbol.KINDMASK) : symbol;
            return;
        }
        if (!symbol.isImportBinding()) {
            if (symbol.isBlockScoped() || symbol.isVarRedeclaredHere()) {
                blockScopedOrRedeclaredSymbols++;
            }
            if (symbol.isBlockScoped() || (symbol.isVar() && !symbol.isParam())) {
                declaredNames++;
            }
        }
    }

    public boolean hasBlockScopedOrRedeclaredSymbols() {
        return blockScopedOrRedeclaredSymbols != 0;
    }

    public boolean hasDeclarations() {
        return declaredNames != 0;
    }

    /**
     * Returns true if the name is lexically declared in this scope or any of its enclosing scopes
     * within this function.
     *
     * @param varName the declared name
     * @param annexB if true, ignore catch parameters
     * @param includeParameters include parameter scope?
     */
    public boolean isLexicallyDeclaredName(final String varName, final boolean annexB, final boolean includeParameters) {
        for (Scope current = this; current != null; current = current.getParent()) {
            Symbol existingSymbol = current.getExistingSymbol(varName);
            if (existingSymbol != null && existingSymbol.isBlockScoped()) {
                if (existingSymbol.isCatchParameter() && annexB) {
                    continue; // B.3.5 VariableStatements in Catch Blocks
                }
                return true;
            }
            if (includeParameters ? current.isFunctionTopScope() : current.isFunctionBodyScope()) {
                break;
            }
        }
        return false;
    }

    /**
     * Returns a block scoped symbol in this scope or any of its enclosing scopes within this
     * function.
     *
     * @param varName the symbol name
     */
    public Symbol findBlockScopedSymbolInFunction(String varName) {
        for (Scope current = this; current != null; current = current.getParent()) {
            Symbol existingSymbol = current.getExistingSymbol(varName);
            if (existingSymbol != null) {
                if (existingSymbol.isBlockScoped()) {
                    return existingSymbol;
                } else {
                    // early exit
                    break;
                }
            }
            if (current.isFunctionTopScope()) {
                break;
            }
        }
        return null;
    }

    public void recordHoistedVarDeclaration(final VarNode varDecl, final Scope scope) {
        assert !varDecl.isBlockScoped();
        if (hoistedVarDeclarations == null) {
            hoistedVarDeclarations = new ArrayList<>();
        }
        hoistedVarDeclarations.add(new AbstractMap.SimpleImmutableEntry<>(varDecl, scope));
    }

    public VarNode verifyHoistedVarDeclarations() {
        if (hoistedVarDeclarations == null) {
            // nothing to do
            return null;
        }
        for (Map.Entry<VarNode, Scope> entry : hoistedVarDeclarations) {
            VarNode varDecl = entry.getKey();
            Scope declScope = entry.getValue();
            String varName = varDecl.getName().getName();
            for (Scope current = declScope; current != this; current = current.getParent()) {
                Symbol existing = current.getExistingSymbol(varName);
                if (existing != null && existing.isBlockScoped()) {
                    if (existing.isCatchParameter()) {
                        continue; // B.3.5 VariableStatements in Catch Blocks
                    }
                    // let the caller throw the error
                    return varDecl;
                }
            }
        }
        return null;
    }

    public void recordHoistableBlockFunctionDeclaration(final VarNode functionDeclaration, final Scope scope) {
        assert functionDeclaration.isFunctionDeclaration() && functionDeclaration.isBlockScoped();
        if (hoistableBlockFunctionDeclarations == null) {
            hoistableBlockFunctionDeclarations = new ArrayList<>();
        }
        hoistableBlockFunctionDeclarations.add(new AbstractMap.SimpleImmutableEntry<>(functionDeclaration, scope));
    }

    public void declareHoistedBlockFunctionDeclarations() {
        if (hoistableBlockFunctionDeclarations == null) {
            // nothing to do
            return;
        }
        next: for (Map.Entry<VarNode, Scope> entry : hoistableBlockFunctionDeclarations) {
            VarNode functionDecl = entry.getKey();
            Scope functionDeclScope = entry.getValue();
            String varName = functionDecl.getName().getName();
            for (Scope current = functionDeclScope.getParent(); current != null; current = current.getParent()) {
                Symbol existing = current.getExistingSymbol(varName);
                if (existing != null && ((existing.isBlockScoped() && !existing.isCatchParameter()) || existing.isParam())) {
                    // lexical declaration or parameter found, do not hoist
                    continue next;
                }
                if (current.isFunctionTopScope()) {
                    break;
                }
            }
            // declare var (if not already declared) and hoist the function declaration
            if (getExistingSymbol(varName) == null) {
                putSymbol(new Symbol(varName, Symbol.IS_VAR | (isGlobalScope() ? Symbol.IS_GLOBAL : 0)));
            }
            functionDeclScope.getExistingSymbol(varName).setHoistedBlockFunctionDeclaration();
        }
    }

    public boolean isBlockScope() {
        return (type & BLOCK_SCOPE) != 0;
    }

    public boolean isFunctionBodyScope() {
        return (type & FUNCTION_BODY_SCOPE) != 0;
    }

    public boolean isFunctionParameterScope() {
        return (type & FUNCTION_PARAMETER_SCOPE) != 0;
    }

    public boolean isCatchParameterScope() {
        return (type & CATCH_PARAMETER_SCOPE) != 0;
    }

    public boolean isGlobalScope() {
        return (type & GLOBAL_SCOPE) != 0;
    }

    public boolean isModuleScope() {
        return (type & MODULE_SCOPE) != 0;
    }

    public boolean isFunctionTopScope() {
        return (type & FUNCTION_TOP_SCOPE) != 0;
    }

    /**
     * Closes the scope for symbol registration.
     */
    public void close() {
        if (closed) {
            return;
        }
        if (hoistableBlockFunctionDeclarations != null) {
            declareHoistedBlockFunctionDeclarations();
        }
        closed = true;
    }

    @Override
    public String toString() {
        StringJoiner names = new StringJoiner(",", "(", ")");
        for (String name : symbols.getKeys()) {
            names.add(name);
        }
        return "[" + getScopeKindName() + "Scope" + names + (parent == null ? "" : ", " + parent + "") + "]";
    }

    private String getScopeKindName() {
        if (isGlobalScope()) {
            return "Global";
        } else if (isModuleScope()) {
            return "Module";
        } else if (isFunctionBodyScope()) {
            return "Var";
        } else if (isFunctionParameterScope()) {
            return "Param";
        } else if (isCatchParameterScope()) {
            return "Catch";
        }
        return "";
    }
}
