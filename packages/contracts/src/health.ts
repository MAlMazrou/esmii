import Type from "typebox";

export const LiveHealthResponseSchema = Type.Object(
  { status: Type.Literal("ok") },
  { additionalProperties: false },
);

export const ReadyHealthResponseSchema = Type.Object(
  { status: Type.Union([Type.Literal("ready"), Type.Literal("not_ready")]) },
  { additionalProperties: false },
);

export const DependencyStateSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("degraded"),
  Type.Literal("unavailable"),
  Type.Literal("disabled"),
]);

export const DependencyHealthSchema = Type.Object(
  {
    status: DependencyStateSchema,
    requiredForReadiness: Type.Boolean(),
    latencyMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const DependenciesHealthResponseSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("degraded")]),
    checkedAt: Type.String({ format: "date-time" }),
    dependencies: Type.Record(Type.String({ minLength: 1, maxLength: 80 }), DependencyHealthSchema),
  },
  { additionalProperties: false },
);

export type LiveHealthResponse = Type.Static<typeof LiveHealthResponseSchema>;
export type ReadyHealthResponse = Type.Static<typeof ReadyHealthResponseSchema>;
export type DependencyState = Type.Static<typeof DependencyStateSchema>;
export type DependencyHealth = Type.Static<typeof DependencyHealthSchema>;
export type DependenciesHealthResponse = Type.Static<typeof DependenciesHealthResponseSchema>;
