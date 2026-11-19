import "@typespec/rest";
import "@typespec/versioning";
import "@azure-tools/typespec-azure-core";
import "@azure-tools/typespec-azure-resource-manager";

using TypeSpec.Http;
using TypeSpec.Rest;
using TypeSpec.Versioning;
using Azure.Core;
using Azure.ResourceManager;

/** Non-shipping ARM compatibility fixture. */
@armProviderNamespace
@service(#{ title: "Contoso ARM compatibility fixture" })
@versioned(Versions)
namespace Microsoft.ContosoBreakingChanges;

/** Stable versions used to exercise resource-level breaking changes. */
enum Versions {
  /** Initial stable resource contract. */
  @armCommonTypesVersion(Azure.ResourceManager.CommonTypes.Versions.v5)
  v1: "2026-01-01",

  /** Unchanged subsequent stable resource contract. */
  @armCommonTypesVersion(Azure.ResourceManager.CommonTypes.Versions.v5)
  v2: "2026-06-01",
}

/** A resource with the same model in request and response positions. */
model Widget is TrackedResource<WidgetProperties> {
  ...ResourceNameParameter<Widget>;
}

/** Properties shared by read, create, update and list operations. */
model WidgetProperties {
  /** City associated with this resource. */
  city?: string;

  /** Requested processing mode. */
  mode?: "fast" | "safe";

  /** Result of the latest provisioning operation. */
  @visibility(Lifecycle.Read)
  provisioningState?: ResourceProvisioningState;
}

/** Standard provider operations. */
interface Operations extends Azure.ResourceManager.Operations {}

/** Standard resource lifecycle used only for compatibility testing. */
@armResourceOperations
interface Widgets {
  get is ArmResourceRead<Widget>;
  createOrUpdate is ArmResourceCreateOrReplaceSync<Widget>;
  update is ArmCustomPatchSync<
    Widget,
    Azure.ResourceManager.Foundations.ResourceUpdateModel<Widget, WidgetProperties>
  >;
  delete is ArmResourceDeleteSync<Widget>;
  listByResourceGroup is ArmResourceListByParent<Widget>;
  listBySubscription is ArmListBySubscription<Widget>;
}
