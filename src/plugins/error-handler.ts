import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyError } from "fastify";
import fp from "fastify-plugin";
import { env } from "../config/env.js";

interface ErrorResponse {
  success: false;
  error: string;
  statusCode: number;
  stack?: string;
}

async function errorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      app.log.error(error, error.message);
    } else {
      app.log.warn(error, error.message);
    }

    const response: ErrorResponse = {
      success: false,
      error: statusCode >= 500 ? "Internal Server Error" : error.message,
      statusCode,
    };

    if (env.NODE_ENV === "development") {
      response.error = error.message;
      response.stack = error.stack;
    }

    reply.status(statusCode).send(response);
  });

  app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    reply.status(404).send({
      success: false,
      error: "Route not found",
      statusCode: 404,
    });
  });
}

export const errorHandlerPlugin = fp(errorHandler, {
  name: "error-handler",
});
