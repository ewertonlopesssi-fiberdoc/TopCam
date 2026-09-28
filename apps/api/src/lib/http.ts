import type { FastifyReply } from "fastify";
import { z } from "zod";

/** Erro de negócio com status HTTP e código estável (consumido pelo painel e pelo app). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, "bad_request", message, details);
export const unauthorized = (message = "Não autenticado") =>
  new HttpError(401, "unauthorized", message);
export const forbidden = (message = "Sem permissão para esta ação") =>
  new HttpError(403, "forbidden", message);
export const notFound = (message = "Não encontrado") => new HttpError(404, "not_found", message);
export const conflict = (message: string, code = "conflict") => new HttpError(409, code, message);

export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    throw badRequest(
      "Dados inválidos",
      r.error.issues.map((i) => ({ campo: i.path.join("."), erro: i.message })),
    );
  }
  return r.data;
}

export function sendError(reply: FastifyReply, err: HttpError) {
  return reply.code(err.status).send({
    error: err.code,
    message: err.message,
    ...(err.details ? { details: err.details } : {}),
  });
}

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const uuid = z.string().uuid();
