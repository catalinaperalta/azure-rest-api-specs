namespace Contoso.BreakingChangeDemo;

/** Parameters accepted only in requests. */
model WidgetInput {
  /** Human-readable widget name. */
  name: string;

  /** Requested processing mode. */
  mode: "fast" | "safe";

  /** Optional caller note. */
  note?: string;

  /** Required input with an explicitly reviewable exception. */
  @TypeSpec.Versioning.added(Versions.v3)
  @Azure.Core.approvedBreakingChange("Required fixture token is an intentional exception.", #{ since: "2026-10-01" })
  token: string;
}

/** Body returned only in responses. */
@Azure.Core.approvedBreakingChange(
  "Baseline fixture approval retained to test existing approval classification.",
  #{ kind: "ResponsePropertyRemoved", path: "legacy" }
)
model WidgetOutput {
  /** Human-readable widget name. */
  name: string;

  /** City associated with the widget. */
  @TypeSpec.Versioning.removed(Versions.v3)
  @Azure.Core.approvedBreakingChange("City removal is approved for the non-shipping fixture.", #{ since: "2026-10-01" })
  city: string;

  /** Status guaranteed by the response contract. */
  status: "ready" | "pending";

  /** Retained legacy field used by approval lifecycle tests. */
  legacy: string;
}

/** Successful widget response with explicit HTTP metadata. */
model WidgetResponse {
  /** Successful completion status. */
  @TypeSpec.Http.statusCode statusCode: 200;

  /** Serialized response media type. */
  @TypeSpec.Http.header contentType: "application/json";

  /** Service revision returned to callers. */
  @TypeSpec.Http.header("x-service-revision") revision: string;

  /** Widget representation. */
  @TypeSpec.Http.body body: WidgetOutput;
}
