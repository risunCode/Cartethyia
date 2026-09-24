import { t } from "elysia";

/**
 * Builds an Elysia string-literal union from the canonical tuple that already
 * declares those values.
 *
 * The alternative — `t.Union([t.Literal("a"), t.Literal("b")])` — restates the
 * tuple by hand at every route that accepts it, so adding a member to the
 * canonical tuple leaves the HTTP schema silently one member behind. Handing
 * the tuple to this helper makes the schema a projection of the same
 * declaration the TypeScript union and the operations-layer validators read.
 *
 * `t.UnionEnum` is not a substitute: it stamps a `default` of the first member,
 * which would make an absent body field validate as that member instead of
 * staying absent.
 */
export function literalUnion<T extends string>(values: readonly T[]) {
  return t.Union(values.map((value) => t.Literal(value)));
}
