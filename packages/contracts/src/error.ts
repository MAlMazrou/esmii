import Type from "typebox";

export const ErrorBodySchema = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 80 }),
    message: Type.String({ minLength: 1, maxLength: 240 }),
    requestId: Type.String({ minLength: 1, maxLength: 160 }),
  },
  { additionalProperties: false },
);

export const ErrorResponseSchema = Type.Object(
  { error: ErrorBodySchema },
  { additionalProperties: false },
);

export type ErrorBody = Type.Static<typeof ErrorBodySchema>;
export type ErrorResponse = Type.Static<typeof ErrorResponseSchema>;
