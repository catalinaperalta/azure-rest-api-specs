import "@typespec/http";
import "@typespec/versioning";
import "@azure-tools/typespec-azure-core";
import "./models.tsp";

using TypeSpec.Http;
using TypeSpec.Versioning;
using Azure.Core;

/** Non-shipping HTTP compatibility test service. */
@service(#{ title: "Contoso breaking change demo" })
@server("https://example.com", "Non-shipping compatibility fixture.")
@useAuth(ApiKeyAuth<ApiKeyLocation.header, "x-api-key">)
@versioned(Contoso.BreakingChangeDemo.Versions)
namespace Contoso.BreakingChangeDemo;

/** API versions retained by the compatibility fixture. */
enum Versions {
  /** Initial stable contract. */
  v1: "2026-01-01",

  /** Subsequent stable contract with the same wire shape. */
  v2: "2026-06-01",

  /** Scenario version 2026-08-01-preview. */
  v3: "2026-08-01-preview",

  /** Scenario version 2026-09-01-preview. */
  v4: "2026-09-01-preview",

  /** Scenario version 2026-10-01. */
  v5: "2026-10-01",
}

/** Creates a widget using an independently modeled request. */
@route("/widgets")
@post
op create(
  /** Limits the number of related items. */
  @query limit?: int32,
  /** Identifies an optional caller feature. */
  @header("x-feature") feature?: string,
  /** Widget creation parameters. */
  @body body: WidgetInput,
): WidgetResponse;

/** Reads a widget by its stable identifier. */
@route("/widgets/{widgetId}")
@get
op read(
  /** Identifier of the widget to read. */
  @path widgetId: string,
): WidgetResponse;

/** Reads a second representation sharing the same named response model. */
@route("/widget-copy/{widgetId}")
@get
op readCopy(
  /** Identifier of the widget to read. */
  @path widgetId: string,
): WidgetResponse;
