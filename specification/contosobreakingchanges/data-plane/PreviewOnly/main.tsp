import "@typespec/http";
import "@typespec/versioning";

using TypeSpec.Http;
using TypeSpec.Versioning;

/** Independent fixture for multi-project report aggregation. */
@service(#{ title: "Contoso breaking change peer" })
@server("https://example.com", "Non-shipping compatibility fixture.")
@useAuth(ApiKeyAuth<ApiKeyLocation.header, "x-api-key">)
@versioned(Contoso.PreviewOnly.Versions)
namespace Contoso.PreviewOnly;

/** Supported fixture versions. */
enum Versions {
  /** Initial stable contract. */
  v1: "2026-01-01-preview",
  /** Subsequent preview. */
  v2: "2026-06-01-preview",
}

/** Independent peer representation. */
model Peer {
  /** Stable representation identifier. */
  @TypeSpec.Versioning.removed(Versions.v2)
  id: string;
}

/** Reads the independent peer representation. */
@route("/peer")
@get
op read(): Peer;
