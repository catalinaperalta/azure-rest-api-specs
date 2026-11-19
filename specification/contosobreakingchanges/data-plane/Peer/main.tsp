import "@typespec/http";
import "@typespec/versioning";

using TypeSpec.Http;
using TypeSpec.Versioning;

/** Independent fixture for multi-project report aggregation. */
@service(#{ title: "Contoso breaking change peer" })
@server("https://example.com", "Non-shipping compatibility fixture.")
@useAuth(ApiKeyAuth<ApiKeyLocation.header, "x-api-key">)
@versioned(Contoso.BreakingChangePeer.Versions)
namespace Contoso.BreakingChangePeer;

/** Supported fixture versions. */
enum Versions {
  /** Initial stable contract. */
  v1: "2026-01-01",
}

/** Independent peer representation. */
model Peer {
  /** Stable representation identifier. */
  id: string;
}

/** Reads the independent peer representation. */
@route("/peer")
@get
op read(): Peer;
