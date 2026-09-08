import "@typespec/rest";
import "@typespec/http";
import "@typespec/versioning";
import "@azure-tools/typespec-azure-core";
import "@azure-tools/typespec-azure-resource-manager";

using TypeSpec.Rest;
using TypeSpec.Http;
using TypeSpec.Versioning;
using Azure.Core;
using Azure.ResourceManager;
using Azure.BreakingChange;

namespace Microsoft.Contoso;

/** Employee resource */
model Employee is TrackedResource<EmployeeProperties> {
  ...ResourceNameParameter<Employee>;
}

/** Employee properties */
@approvedUnversionedChange(
  "Demo: city was intentionally removed in a same-version edit to exercise the Phase A unversioned-change approval workflow.",
  #{ kind: "ResourcePropertyRemoved", path: "city" }
)
model EmployeeProperties {
  /** Age of employee */
  @madeRequired(Versions.v2022_01_01)
  @approvedBreakingChange(
    "Demo: age was intentionally made required in 2022-01-01 to exercise the Phase B breaking-change approval workflow.",
    #{ kind: "ResourcePropertyMadeRequired" }
  )
  age: int32;

  /** Profile of employee */
  @encode("base64url")
  profile?: bytes;

  /** The status of the last operation. */
  @visibility(Lifecycle.Read)
  provisioningState?: ProvisioningState;
}

/** The resource provisioning state. */
@lroStatus
union ProvisioningState {
  ResourceProvisioningState,

  /** The resource is being provisioned */
  Provisioning: "Provisioning",

  /** The resource is updating */
  Updating: "Updating",

  /** The resource is being deleted */
  Deleting: "Deleting",

  /** The resource create request has been accepted */
  Accepted: "Accepted",

  string,
}

@armResourceOperations
interface Employees {
  get is ArmResourceRead<Employee>;
  createOrUpdate is ArmResourceCreateOrReplaceAsync<Employee>;
  update is ArmResourcePatchSync<Employee, EmployeeProperties>;
  delete is ArmResourceDeleteWithoutOkAsync<Employee>;
  listByResourceGroup is ArmResourceListByParent<Employee>;
  listBySubscription is ArmListBySubscription<Employee>;
}
