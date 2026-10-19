/**
 * Safe argument serialization and secret redaction utilities for instrumentation.
 */

/**
 * Safely extracts parameter names from a function if available.
 * Fails gracefully for bound functions, native functions, or minified code.
 */
export function getParameterNames(fn: unknown): string[] {
    if (typeof fn !== 'function') return [];
    try {
        const fnStr = Function.prototype.toString
            .call(fn)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n\r]*/g, '');

        const openParen = fnStr.indexOf('(');
        const arrow = fnStr.indexOf('=>');

        let paramStr = '';
        if (openParen !== -1 && (arrow === -1 || openParen < arrow)) {
            let depth = 0;
            let closeParen = -1;
            for (let i = openParen; i < fnStr.length; i++) {
                if (fnStr[i] === '(') depth++;
                else if (fnStr[i] === ')') {
                    depth--;
                    if (depth === 0) {
                        closeParen = i;
                        break;
                    }
                }
            }
            if (closeParen !== -1) {
                paramStr = fnStr.slice(openParen + 1, closeParen);
            }
        } else if (arrow !== -1) {
            paramStr = fnStr.slice(0, arrow).trim();
            paramStr = paramStr.replace(/^async\s+/, '').trim();
        }

        if (!paramStr.trim()) return [];

        return splitTopLevelParams(paramStr)
            .map(extractParamName)
            .filter((p) => p.length > 0 && !p.startsWith('...'));
    } catch {
        return [];
    }
}

function splitTopLevelParams(paramStr: string): string[] {
    const params: string[] = [];
    let current = '';
    let depthParen = 0;
    let depthBrace = 0;
    let depthBracket = 0;
    let inQuote: string | null = null;

    for (let i = 0; i < paramStr.length; i++) {
        const char = paramStr[i];
        if (inQuote) {
            if (char === inQuote && paramStr[i - 1] !== '\\') {
                inQuote = null;
            }
            current += char;
        } else if (char === '"' || char === "'" || char === '`') {
            inQuote = char;
            current += char;
        } else if (char === '(') {
            depthParen++;
            current += char;
        } else if (char === ')') {
            if (depthParen > 0) depthParen--;
            current += char;
        } else if (char === '{') {
            depthBrace++;
            current += char;
        } else if (char === '}') {
            if (depthBrace > 0) depthBrace--;
            current += char;
        } else if (char === '[') {
            depthBracket++;
            current += char;
        } else if (char === ']') {
            if (depthBracket > 0) depthBracket--;
            current += char;
        } else if (char === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
            params.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim().length > 0) {
        params.push(current.trim());
    }
    return params;
}

function extractParamName(rawParam: string): string {
    let param = rawParam.trim();
    let depthParen = 0;
    let depthBrace = 0;
    let depthBracket = 0;
    for (let i = 0; i < param.length; i++) {
        const c = param[i];
        if (c === '(') depthParen++;
        else if (c === ')') { if (depthParen > 0) depthParen--; }
        else if (c === '{') depthBrace++;
        else if (c === '}') { if (depthBrace > 0) depthBrace--; }
        else if (c === '[') depthBracket++;
        else if (c === ']') { if (depthBracket > 0) depthBracket--; }
        else if (c === '=' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
            param = param.slice(0, i).trim();
            break;
        }
    }
    depthParen = 0; depthBrace = 0; depthBracket = 0;
    for (let i = 0; i < param.length; i++) {
        const c = param[i];
        if (c === '(') depthParen++;
        else if (c === ')') { if (depthParen > 0) depthParen--; }
        else if (c === '{') depthBrace++;
        else if (c === '}') { if (depthBrace > 0) depthBrace--; }
        else if (c === '[') depthBracket++;
        else if (c === ']') { if (depthBracket > 0) depthBracket--; }
        else if (c === ':' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
            param = param.slice(0, i).trim();
            break;
        }
    }
    return param;
}

/**
 * Safely stringifies a value with bounded length, circular reference handling,
 * BigInt support, and key-level redaction.
 *
 * Fails closed: If stringification throws or fails when redacting, it returns '[REDACTED]'
 * rather than leaking raw data into telemetry.
 */
export function safeStringify(
    value: unknown,
    skipSet?: ReadonlySet<string>,
    maxLength = 1000
): string {
    const seen = new WeakSet<object>();
    try {
        const str = JSON.stringify(value, (key, val) => {
            // Key-level redaction on serialized representation
            if (key && skipSet && skipSet.has(key.toLowerCase())) {
                return '[REDACTED]';
            }
            if (typeof val === 'bigint') {
                return `${val.toString()}n`;
            }
            if (typeof val === 'object' && val !== null) {
                if (seen.has(val)) {
                    return '[Circular]';
                }
                seen.add(val);
            }
            return val;
        });
        return (str ?? String(value)).slice(0, maxLength);
    } catch {
        // Fail-closed policy: never leak unredacted data if serialization encounters an error
        return skipSet && skipSet.size > 0 ? '[REDACTED]' : '[Unserializable]';
    }
}

/**
 * Serializes function arguments into a bounded string while redacting sensitive arguments.
 *
 * Redaction applies:
 * 1. By property key: any object key matching skipArgs is redacted to '[REDACTED]'.
 * 2. By positional index: any index specified in skipArgs (e.g. '0', '1') is redacted.
 * 3. By parameter name: if runtime parameter names are available and match skipArgs, redacted.
 *
 * Fails closed: If any error occurs during processing, returns '[REDACTED]' to ensure secrets
 * never reach telemetry.
 */
export function safeSerializeArgs(
    fn: unknown,
    args: unknown[],
    skipArgs?: readonly string[],
    maxLength = 1000
): string {
    if (!args || args.length === 0) {
        return '[]';
    }

    const hasSkip = Boolean(skipArgs && skipArgs.length > 0);
    const skipSet = hasSkip
        ? new Set(skipArgs!.map((s) => String(s).toLowerCase().trim()))
        : undefined;

    try {
        const paramNames = hasSkip ? getParameterNames(fn) : [];

        const processedArgs = args.map((arg, idx) => {
            if (skipSet) {
                const paramName = paramNames[idx]?.toLowerCase();
                if ((paramName && skipSet.has(paramName)) || skipSet.has(String(idx))) {
                    return '[REDACTED]';
                }
            }
            return arg;
        });

        return safeStringify(processedArgs, skipSet, maxLength);
    } catch {
        // Fail-closed: Never leak arguments on error
        return hasSkip ? '[REDACTED]' : '[]';
    }
}
