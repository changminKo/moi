import type { FastifyError, FastifyInstance } from 'fastify';

interface StableError {
  readonly code: string;
  readonly message: string;
  readonly retryable: false;
  readonly requestId: string;
}

function stableError(
  error: FastifyError,
  requestId: string,
): { status: number; body: StableError } {
  const status = error.statusCode ?? 500;
  if (status === 404) {
    return {
      status,
      body: {
        code: 'NOT_FOUND',
        message: 'Route not found',
        retryable: false,
        requestId,
      },
    };
  }
  if (status === 413 || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return {
      status: 413,
      body: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body is too large',
        retryable: false,
        requestId,
      },
    };
  }
  if (status === 400 || error.validation) {
    return {
      status: 400,
      body: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        retryable: false,
        requestId,
      },
    };
  }
  if (status === 403) {
    return {
      status,
      body: {
        code: 'FORBIDDEN',
        message: 'Request origin is not allowed',
        retryable: false,
        requestId,
      },
    };
  }
  return {
    status: status >= 400 && status < 600 ? status : 500,
    body: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      retryable: false,
      requestId,
    },
  };
}

export async function registerErrorHandler(
  app: FastifyInstance,
): Promise<void> {
  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(stableError({ statusCode: 404 } as FastifyError, request.id).body);
  });
  app.setErrorHandler((error, request, reply) => {
    const result = stableError(error as FastifyError, request.id);
    reply.code(result.status).send(result.body);
  });
}
