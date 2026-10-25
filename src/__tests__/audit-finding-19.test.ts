/**
 * Regression and verification test suite for Audit Finding 19 (2026-10-09).
 *
 * Covers:
 * 1. Native OTel child inside active Traccia span shares trace and parent.
 * 2. Express and Fastify middlewares extract incoming W3C trace context and make
 *    request span active for next() / hookDone().
 * 3. Explicit parent traceFlags=0 is preserved (not coerced to 1 via || 1)
 *    and tracestate is propagated.
 */

import { EventEmitter } from 'events';
import { trace, context as otelContext } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { TracerProvider } from '../tracer/provider';
import { getCurrentSpan, runWithSpan, spanScope } from '../context';
import { expressMiddleware } from '../instrumentation/express';
import { fastifyPlugin } from '../instrumentation/fastify';
import { GuardrailDetectorProcessor } from '../processor/guardrail-detector';
import { ISpan } from '../types';

describe('Audit Finding 19: OTel Context Bridging and W3C Propagation', () => {
  let basicProvider: BasicTracerProvider;
  let tracciaProvider: TracerProvider;

  beforeAll(() => {
    basicProvider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(basicProvider);
  });

  beforeEach(() => {
    tracciaProvider = new TracerProvider();
  });

  describe('Reproduction 1: Active Traccia span bridges to OTel context', () => {
    it('native OTel child inside active Traccia span shares trace and parent span', async () => {
      const tracer = tracciaProvider.getTracer('test-bridge');

      await tracer.startActiveSpan('traccia-active', async (activeSpan) => {
        expect(getCurrentSpan()).toBe(activeSpan);

        // Active OTel span matches the Traccia span's underlying OTel span
        const activeOtelSpan = trace.getActiveSpan();
        expect(activeOtelSpan).toBeDefined();
        expect(activeOtelSpan?.spanContext().spanId).toBe(activeSpan.context.spanId);
        expect(activeOtelSpan?.spanContext().traceId).toBe(activeSpan.context.traceId);

        // Native OTel child created inside active Traccia span
        const nativeTracer = trace.getTracer('native-lib');
        const nativeChild = nativeTracer.startSpan('native-child');

        try {
          const childCtx = nativeChild.spanContext();
          expect(childCtx.traceId).toBe(activeSpan.context.traceId);
          expect((nativeChild as any).parentSpanContext?.spanId).toBe(activeSpan.context.spanId);
        } finally {
          nativeChild.end();
        }
      });
    });

    it('spanScope.run and spanScope.runAsync bridge to OTel context', async () => {
      const scope = spanScope('scope-parent', { tracerName: 'scope-tracer' });
      const parentSpan = scope.span;

      // Synchronous run
      scope.run(() => {
        const nativeTracer = trace.getTracer('native-sync');
        const nativeChild = nativeTracer.startSpan('native-child-sync');
        try {
          expect(nativeChild.spanContext().traceId).toBe(parentSpan.context.traceId);
          expect((nativeChild as any).parentSpanContext?.spanId).toBe(parentSpan.context.spanId);
        } finally {
          nativeChild.end();
        }
      });

      // Asynchronous run
      await scope.runAsync(async () => {
        const nativeTracer = trace.getTracer('native-async');
        const nativeChild = nativeTracer.startSpan('native-child-async');
        try {
          expect(nativeChild.spanContext().traceId).toBe(parentSpan.context.traceId);
          expect((nativeChild as any).parentSpanContext?.spanId).toBe(parentSpan.context.spanId);
        } finally {
          nativeChild.end();
        }
      });

      scope.end();
    });
  });

  describe('Reproduction 2: Express & Fastify middleware extract W3C context & activate span', () => {
    it('Express middleware extracts incoming traceparent and makes request span active for next()', (done) => {
      const incomingTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const incomingSpanId = '00f067aa0ba902b7';
      const incomingTraceState = 'rojo=1,congo=2';
      const traceparent = `00-${incomingTraceId}-${incomingSpanId}-01`;

      const req: any = {
        method: 'GET',
        url: '/api/resource',
        path: '/api/resource',
        headers: {
          traceparent,
          tracestate: incomingTraceState,
        },
      };

      const res: any = {
        statusCode: 200,
        on: jest.fn(),
      };

      const middleware = expressMiddleware();

      middleware(req, res, () => {
        try {
          // Request span should be stored on request
          const requestSpan = req._tracciaSpan;
          expect(requestSpan).toBeDefined();
          expect(requestSpan.context.traceId).toBe(incomingTraceId);
          expect(requestSpan.parentSpanId).toBe(incomingSpanId);

          // Request span should be active in context during next()
          expect(getCurrentSpan()).toBe(requestSpan);

          // A Traccia child span created inside handler inherits trace and request parent
          const tracer = tracciaProvider.getTracer('express-handler');
          const handlerSpan = tracer.startSpan('handler-operation');
          expect(handlerSpan.context.traceId).toBe(incomingTraceId);
          expect(handlerSpan.parentSpanId).toBe(requestSpan.context.spanId);
          handlerSpan.end();

          // A native OTel child span created inside handler also inherits trace and request parent
          const nativeTracer = trace.getTracer('native-db');
          const nativeChild = nativeTracer.startSpan('db-query');
          expect(nativeChild.spanContext().traceId).toBe(incomingTraceId);
          expect((nativeChild as any).parentSpanContext?.spanId).toBe(requestSpan.context.spanId);
          nativeChild.end();

          done();
        } catch (error) {
          done(error);
        }
      });
    });

    it('Fastify plugin extracts incoming traceparent and makes request span active for hookDone()', (done) => {
      const incomingTraceId = '5cb73e4688b44ea7b4df838e1f1f5847';
      const incomingSpanId = '11a178bb1ca013c8';
      const traceparent = `00-${incomingTraceId}-${incomingSpanId}-01`;

      const hooks: Record<string, Function> = {};
      const mockFastify: any = {
        addHook: jest.fn((name, handler) => {
          hooks[name] = handler;
        }),
      };

      const plugin = fastifyPlugin();
      plugin(mockFastify, {}, () => {});

      const req: any = {
        method: 'POST',
        url: '/items',
        routerPath: '/items',
        headers: {
          traceparent,
        },
      };

      hooks['onRequest'](req, {}, () => {
        try {
          const requestSpan = req._tracciaSpan;
          expect(requestSpan).toBeDefined();
          expect(requestSpan.context.traceId).toBe(incomingTraceId);
          expect(requestSpan.parentSpanId).toBe(incomingSpanId);

          // Active in context
          expect(getCurrentSpan()).toBe(requestSpan);

          const tracer = tracciaProvider.getTracer('fastify-handler');
          const handlerSpan = tracer.startSpan('save-item');
          expect(handlerSpan.context.traceId).toBe(incomingTraceId);
          expect(handlerSpan.parentSpanId).toBe(requestSpan.context.spanId);
          handlerSpan.end();

          done();
        } catch (error) {
          done(error);
        }
      });
    });
  });

  describe('Reproduction 3: Explicit parent traceFlags=0 and tracestate preservation', () => {
    it('preserves traceFlags=0 and tracestate when parentContext has traceFlags=0', () => {
      const tracer = tracciaProvider.getTracer('test-flags');
      const parentContext = {
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        traceFlags: 0, // Unsampled
        traceState: 'vendor1=val1,vendor2=val2',
      };

      const child = tracer.startSpan('child-unsampled', { parentContext });

      expect(child.context.traceId).toBe(parentContext.traceId);
      expect(child.parentSpanId).toBe(parentContext.spanId);
      expect(child.context.traceFlags).toBe(0); // Must remain 0, NOT become 1
      expect(child.context.traceState).toBe('vendor1=val1,vendor2=val2');
      child.end();
    });

    it('preserves traceFlags=0 and tracestate when options.parent has traceFlags=0', () => {
      const tracer = tracciaProvider.getTracer('test-flags-parent');

      // Create a mock parent ISpan with unsampled flag and tracestate
      const parentSpan: ISpan = {
        context: {
          traceId: '7af83e4688b44ea7b4df838e1f1f5847',
          spanId: '22b278bb1ca013c9',
          traceFlags: 0,
          traceState: 'congo=uc,rojo=plain',
        },
        name: 'mock-parent',
        attributes: {},
        events: [],
        status: 0,
        startTimeNs: 0,
        durationNs: undefined,
        setAttribute: jest.fn(),
        addEvent: jest.fn(),
        end: jest.fn(),
        recordException: jest.fn(),
        isRecording: () => false,
      };

      const child = tracer.startSpan('child-from-parent', { parent: parentSpan });

      expect(child.context.traceId).toBe(parentSpan.context.traceId);
      expect(child.parentSpanId).toBe(parentSpan.context.spanId);
      expect(child.context.traceFlags).toBe(0); // Must remain 0
      expect(child.context.traceState).toBe('congo=uc,rojo=plain');
      child.end();
    });

    it('preserves traceFlags=0 and tracestate when active parent has traceFlags=0', () => {
      const tracer = tracciaProvider.getTracer('test-active-flags');

      const parentSpan: ISpan = {
        context: {
          traceId: '9af83e4688b44ea7b4df838e1f1f5847',
          spanId: '33b278bb1ca013c9',
          traceFlags: 0,
          traceState: 'alpha=one',
        },
        name: 'active-unsampled-parent',
        attributes: {},
        events: [],
        status: 0,
        startTimeNs: 0,
        durationNs: undefined,
        setAttribute: jest.fn(),
        addEvent: jest.fn(),
        end: jest.fn(),
        recordException: jest.fn(),
        isRecording: () => false,
      };

      runWithSpan(parentSpan, () => {
        const child = tracer.startSpan('child-auto-parent');
        expect(child.context.traceId).toBe(parentSpan.context.traceId);
        expect(child.parentSpanId).toBe(parentSpan.context.spanId);
        expect(child.context.traceFlags).toBe(0);
        expect(child.context.traceState).toBe('alpha=one');
        child.end();
      });
    });
  });

  describe('Reproduction 4: Bound callbacks preserve dynamic this receiver (Comment 2)', () => {
    it('forwards the dynamic this receiver to bound functions instead of passing undefined', () => {
      const tracer = tracciaProvider.getTracer('test-this-receiver');
      const testSpan = tracer.startSpan('this-receiver-span');

      const fakeResponse = {
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-42' } as Record<string, string>,
        getHeader(name: string): string | undefined {
          return this.headers[name.toLowerCase()];
        },
      };

      const activeCtx = otelContext.active();
      // Bind callback to active context
      const boundGetHeader = otelContext.bind(activeCtx, fakeResponse.getHeader);

      // Invoking bound callback with dynamic receiver 'fakeResponse' must not throw
      expect(() => {
        const ct = boundGetHeader.call(fakeResponse, 'content-type');
        expect(ct).toBe('application/json');
      }).not.toThrow();

      expect(boundGetHeader.call(fakeResponse, 'x-request-id')).toBe('req-42');
      testSpan.end();
    });
  });

  describe('Reproduction 5: EventEmitter context binding preserves active span (Comment 3)', () => {
    it('propagates bound context into listeners registered on bound EventEmitter', (done) => {
      const tracer = tracciaProvider.getTracer('test-ee-binding');
      const parentSpan = tracer.startSpan('ee-parent-span');

      runWithSpan(parentSpan, () => {
        const ee = new EventEmitter();
        const activeCtx = otelContext.active();

        // Bind emitter to current context
        const boundEE = otelContext.bind(activeCtx, ee);

        // Register listener on bound emitter
        boundEE.on('data', () => {
          try {
            // Listener should run with parentSpan active in OTel context
            const activeSpan = trace.getActiveSpan();
            expect(activeSpan?.spanContext().spanId).toBe(parentSpan.context.spanId);
            expect(activeSpan?.spanContext().traceId).toBe(parentSpan.context.traceId);
            done();
          } catch (err) {
            done(err);
          } finally {
            parentSpan.end();
          }
        });

        // Emit from an isolated/different context
        otelContext.with(trace.setSpanContext(otelContext.active(), {
          traceId: '11111111111111111111111111111111',
          spanId: '2222222222222222',
          traceFlags: 1,
        }), () => {
          ee.emit('data');
        });
      });
    });
  });

  describe('Reproduction 6: Remote trace headers finalize guardrail state at local request boundary (Comment 1)', () => {
    it('Express middleware finalizes guardrail state despite remote parent and retains 0 traces in memory', (done) => {
      const guardrailProcessor = new GuardrailDetectorProcessor();
      tracciaProvider.addSpanProcessor(guardrailProcessor);

      const incomingTraceId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
      const incomingSpanId = '1234567890abcdef';
      const incomingTraceState = 'vendor=traccia,env=prod';
      const traceparent = `00-${incomingTraceId}-${incomingSpanId}-01`;

      const listeners: Record<string, Function[]> = {};
      const req: any = {
        method: 'POST',
        url: '/api/chat',
        path: '/api/chat',
        headers: {
          traceparent,
          tracestate: incomingTraceState,
        },
      };

      const res: any = {
        statusCode: 200,
        on: jest.fn((event: string, cb: Function) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(cb);
        }),
      };

      // Ensure getTracer uses tracciaProvider with our guardrail processor
      const autoModule = require('../auto');
      const originalGetTracer = autoModule.getTracer;
      autoModule.getTracer = (name: string) => tracciaProvider.getTracer(name);

      try {
        const middleware = expressMiddleware();
        middleware(req, res, () => {
          const requestSpan = req._tracciaSpan;
          expect(requestSpan).toBeDefined();
          expect(requestSpan.context.traceId).toBe(incomingTraceId);
          expect(requestSpan.parentSpanId).toBe(incomingSpanId);
          expect(requestSpan.isLocalRoot).toBe(true);

          // During request execution, guardrail state is accumulated
          expect(guardrailProcessor.getTraceCount()).toBe(0); // Before any span ends

          // Add a guardrail child span inside request
          const tracer = tracciaProvider.getTracer('chat-agent');
          const childSpan = tracer.startSpan('llm-call', {
            attributes: {
              'prompt': 'Hello world',
            },
          });
          childSpan.end();

          // After child span ends, state is accumulated for the trace
          expect(guardrailProcessor.getTraceCount()).toBe(1);

          // Now response finishes at local request boundary
          for (const cb of listeners['finish'] || []) {
            cb();
          }

          // Guardrail state should be finalized at the local boundary!
          // 1. Guardrail summary should be written onto requestSpan
          expect(requestSpan.attributes['guardrail.summary']).toBeDefined();
          expect(requestSpan.attributes['guardrail.summary.coverage_confidence']).toBeDefined();

          // 2. Trace state should be deleted from memory - 0 retained traces!
          expect(guardrailProcessor.getTraceCount()).toBe(0);

          done();
        });
      } finally {
        autoModule.getTracer = originalGetTracer;
      }
    });

    it('100 completed requests with remote traceparent and tracestate retain 0 traces in memory', () => {
      const guardrailProcessor = new GuardrailDetectorProcessor();
      tracciaProvider.addSpanProcessor(guardrailProcessor);

      const autoModule = require('../auto');
      const originalGetTracer = autoModule.getTracer;
      autoModule.getTracer = (name: string) => tracciaProvider.getTracer(name);

      try {
        const middleware = expressMiddleware();

        for (let i = 0; i < 100; i++) {
          const hexIdx = i.toString(16).padStart(4, '0');
          const incomingTraceId = `11223344556677889900aabbccdd${hexIdx}`;
          const incomingSpanId = `aabbccdd${hexIdx}`;
          const traceparent = `00-${incomingTraceId}-${incomingSpanId}-01`;
          const tracestate = `rojo=1,req=${i}`;

          const listeners: Record<string, Function[]> = {};
          const req: any = {
            method: 'GET',
            url: `/api/items/${i}`,
            path: `/api/items/${i}`,
            headers: {
              traceparent,
              tracestate,
            },
          };

          const res: any = {
            statusCode: 200,
            on: jest.fn((event: string, cb: Function) => {
              listeners[event] = listeners[event] || [];
              listeners[event].push(cb);
            }),
          };

          middleware(req, res, () => {
            // Finish the response
            for (const cb of listeners['finish'] || []) {
              cb();
            }
          });
        }

        // 100 completed requests must retain 0 traces in memory
        expect(guardrailProcessor.getTraceCount()).toBe(0);
      } finally {
        autoModule.getTracer = originalGetTracer;
      }
    });

    it('Fastify plugin finalizes guardrail state despite remote parent and retains 0 traces in memory', () => {
      const guardrailProcessor = new GuardrailDetectorProcessor();
      tracciaProvider.addSpanProcessor(guardrailProcessor);

      const autoModule = require('../auto');
      const originalGetTracer = autoModule.getTracer;
      autoModule.getTracer = (name: string) => tracciaProvider.getTracer(name);

      try {
        const incomingTraceId = '778899aabbccddeeff00112233445566';
        const incomingSpanId = 'fedcba9876543210';
        const traceparent = `00-${incomingTraceId}-${incomingSpanId}-01`;
        const tracestate = 'tenant=acme,tier=gold';

        const hooks: Record<string, Function> = {};
        const mockFastify: any = {
          addHook: jest.fn((name, handler) => {
            hooks[name] = handler;
          }),
        };

        const plugin = fastifyPlugin();
        plugin(mockFastify, {}, () => {});

        const req: any = {
          method: 'POST',
          url: '/fastify-route',
          routerPath: '/fastify-route',
          headers: {
            traceparent,
            tracestate,
          },
        };

        // onRequest hook
        hooks['onRequest'](req, {}, () => {});

        const requestSpan = req._tracciaSpan;
        expect(requestSpan).toBeDefined();
        expect(requestSpan.isLocalRoot).toBe(true);

        // onResponse hook (request completion)
        hooks['onResponse'](req, { statusCode: 200 }, () => {});

        // Summary written on requestSpan and 0 traces retained in memory
        expect(requestSpan.attributes['guardrail.summary']).toBeDefined();
        expect(guardrailProcessor.getTraceCount()).toBe(0);
      } finally {
        autoModule.getTracer = originalGetTracer;
      }
    });
  });
});
