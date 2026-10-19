
import { getTracer } from '../auto';
import { SpanStatus } from '../types';
import { ATTR_GUARDRAIL_TRIGGERED, ATTR_GUARDRAIL_NAME, ATTR_GUARDRAIL_CATEGORY } from '../guardrails/constants';
import { enforceToolCall, noteRetrievalAttributes, rememberToolResult } from '../governance/pep';

export interface ObserveOptions {
    name?: string;
    attributes?: Record<string, unknown>;
    type?: 'span' | 'tool' | 'llm' | 'guardrail';
    /** Alias of `type`. Matches Python `as_type=`. */
    asType?: 'span' | 'tool' | 'llm' | 'guardrail';
    as_type?: 'span' | 'tool' | 'llm' | 'guardrail';
    skipArgs?: string[];
    skip_args?: string[];
    skipResult?: boolean;
    skip_result?: boolean;
    tags?: string[];
    guardrailName?: string;
    guardrailCategory?: string;
}

export function getParameterNames(fn: any): string[] {
    if (typeof fn !== 'function') return [];
    try {
        let fnStr = Function.prototype.toString.call(fn);
        fnStr = fnStr.replace(/\/\/[^\n\r]*/g, '');
        fnStr = fnStr.replace(/\/\*[\s\S]*?\*\//g, '');

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
        }

        if (!paramStr.trim()) return [];

        return paramStr
            .split(',')
            .map((p) => {
                let trimmed = p.trim();
                trimmed = trimmed.replace(/=.*$/, '').trim();
                trimmed = trimmed.replace(/:.*$/, '').trim();
                return trimmed;
            })
            .filter((p) => p.length > 0 && !p.startsWith('...'));
    } catch {
        return [];
    }
}

function redactValueWithSkipList(
    value: unknown,
    skipSet: Set<string>,
    seen = new WeakSet<object>()
): unknown {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'bigint') {
        return `${value.toString()}n`;
    }
    if (typeof value !== 'object') {
        return value;
    }
    if (seen.has(value)) {
        return '[Circular]';
    }
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((item) => redactValueWithSkipList(item, skipSet, seen));
    }

    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
        if (skipSet.has(key.toLowerCase())) {
            result[key] = '[REDACTED]';
        } else {
            result[key] = redactValueWithSkipList(val, skipSet, seen);
        }
    }
    return result;
}

export function safeStringify(value: unknown, maxLength = 1000): string {
    const seen = new WeakSet<object>();
    try {
        const str = JSON.stringify(value, (_key, val) => {
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
        try {
            return String(value).slice(0, maxLength);
        } catch {
            return '[Unserializable]';
        }
    }
}

export function safeSerializeArgs(
    fn: any,
    args: any[],
    skipArgs?: string[],
    maxLength = 1000
): string {
    if (!args || args.length === 0) {
        return '[]';
    }

    const skipSet = new Set(
        (skipArgs || []).map((s) => String(s).toLowerCase().trim())
    );

    const paramNames = getParameterNames(fn);

    const processedArgs = args.map((arg, idx) => {
        const paramName = paramNames[idx]?.toLowerCase();
        if ((paramName && skipSet.has(paramName)) || skipSet.has(String(idx))) {
            return '[REDACTED]';
        }
        if (skipSet.size > 0 && typeof arg === 'object' && arg !== null) {
            return redactValueWithSkipList(arg, skipSet);
        }
        return arg;
    });

    return safeStringify(processedArgs, maxLength);
}

/**
 * Decorator/Wrapper to create spans around functions.
 *
 * Usage:
 * 1. As Method Decorator:
 *    class MyClass {
 *      @observe({ name: 'my-method' })
 *      method() { ... }
 *    }
 *
 * 2. As Function Wrapper:
 *    const protectedFunc = observe({ name: 'my-func' })(originalFunc);
 */
export function observe(options: ObserveOptions = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function (
        target: any,
        propertyKey?: string,
        descriptor?: PropertyDescriptor
    ): any {
        // Case 1: Method Decorator
        if (descriptor && typeof descriptor.value === 'function') {
            const originalMethod = descriptor.value;
            descriptor.value = createWrapper(
                originalMethod,
                options,
                propertyKey || options.name || 'method'
            );
            return descriptor;
        }

        // Case 2: Function Wrapper (target is the function itself)
        if (typeof target === 'function' && !propertyKey && !descriptor) {
            return createWrapper(target, options, options.name || target.name || 'function');
        }

        // Fallback/Error
        return target;
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createWrapper(fn: any, options: ObserveOptions, defaultName: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function (this: any, ...args: any[]) {
        const tracer = getTracer('default');
        const name = options.name || defaultName;

        const spanType = options.asType || options.as_type || options.type || 'span';
        const attributes: Record<string, unknown> = {
            ...(options.attributes || {}),
            'span.type': spanType,
        };

        if (options.tags && options.tags.length > 0) {
            attributes['span.tags'] = options.tags;
        }

        // Capture arguments safely
        const skipArgsList = options.skipArgs || options.skip_args;
        try {
            attributes['function.args'] = safeSerializeArgs(fn, args, skipArgsList);
        } catch {
            // Telemetry capture failures must not stop ordinary application execution
        }

        // Auto-set guardrail attributes if type is guardrail
        if (options.type === 'guardrail') {
            if (options.guardrailName) {
                attributes[ATTR_GUARDRAIL_NAME] = options.guardrailName;
            }
            if (options.guardrailCategory) {
                attributes[ATTR_GUARDRAIL_CATEGORY] = options.guardrailCategory;
            }
        }

        return tracer.startActiveSpan(name, async (span) => {
            // Set initial attributes
            for (const [key, value] of Object.entries(attributes)) {
                span.setAttribute(key, value);
            }

            try {
                if (spanType === 'tool') {
                    const toolArgs =
                        args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])
                            ? (args[0] as Record<string, unknown>)
                            : { args };
                    await enforceToolCall(name, toolArgs);
                }
                const result = await fn.apply(this, args);
                if (spanType === 'tool') {
                    rememberToolResult(name, result);
                }
                noteRetrievalAttributes(span.context?.traceId, span.attributes);

                // Auto-set guardrail.triggered if type is guardrail and result is boolean
                if (spanType === 'guardrail' && typeof result === 'boolean') {
                    span.setAttribute(ATTR_GUARDRAIL_TRIGGERED, result);
                }

                // Capture result
                if (!options.skipResult && !options.skip_result) {
                    try {
                        const resStr = typeof result === 'string' ? result : JSON.stringify(result);
                        span.setAttribute('result', resStr.slice(0, 1000));
                    } catch {
                        span.setAttribute('result', String(result).slice(0, 1000));
                    }
                }

                return result;
            } catch (error) {
                if (error instanceof Error) {
                    span.recordException(error);
                    span.status = SpanStatus.ERROR;
                    if (error.message) {
                        span.statusDescription = error.message;
                    }
                }
                throw error;
            } finally {
                span.end();
            }
        });
    };
}
