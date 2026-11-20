namespace Contoso.BreakingChangeDemo;

/** Parameters accepted only in requests. */
model WidgetInput {
  /** Human-readable widget name. */
  name: string;

  /** Requested processing mode. */
  @TypeSpec.Versioning.typeChangedFrom(Versions.v3, "fast" | "safe")
  mode: "fast";

  /** Optional caller note. */
  @TypeSpec.Versioning.madeRequired(Versions.v3)
  note: string;

  /** Required new-version credential. */
  @TypeSpec.Versioning.added(Versions.v3)
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
