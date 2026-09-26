# V1-C Gaffney-Controlled Client Bootstrap SOP

Status: staging implementation contract. Production execution requires separate authorization.

## State contract

`Setup Requested` records the intended organization, Locations, responsible people, Teams, and app-install requirement. It does not make a Location operational.

`Provisioning` means controlled setup work is in progress. Any incomplete or failed step leaves the request non-ready and preserves its evidence and error context.

`Ready / Active` is reached only when the readiness validator proves every required identity and organizational relationship below. No individual step may directly mark a Location ready.

## Idempotency and evidence

- Every consequential action uses a stable action ID and expected version.
- Replaying the same action ID and payload returns the prior result.
- Reusing an action ID with a different payload fails closed.
- A stale expected version fails with no partial mutation.
- Evidence records contain identifiers, timestamps, actor context, and safe status only. They never contain passwords, OAuth tokens, or other secrets.
- Existing organization, Location, Team, person, and relationship identifiers are reused on rerun. Duplicate identities or duplicate Location-week-like organizational keys are not created.

## Controlled sequence

1. **Organization identity** — create or resolve the organization serial and human-readable name.
2. **Location linkage** — create or resolve each requested Location and bind it to the organization. Logical test Locations remain inside the designated Scope/Test environment.
3. **Marketplace installation** — record evidence that the approved Marketplace app is installed for the intended real Location. This step never copies staging or Production secrets.
4. **Initial continuity actor** — link at least one active Owner or General Manager identity with explicit Location access.
5. **Teams** — create or resolve stable Team identifiers and verify each Team belongs to exactly one requested Location.
6. **Sales Managers** — link identities, set Primary Responsibility, grant explicit Location access, then assign exactly one managed Team. Management assignment is not reporting eligibility.
7. **Sellers** — link identities and set Primary Responsibility without creating permanent Team membership.
8. **Location access** — establish explicit person-to-Location relationships. Names and titles never grant scope.
9. **Team visibility** — establish only the Teams each person may inspect. Visibility does not grant management or reporting eligibility.
10. **Report-to-Team eligibility** — establish explicit event-destination eligibility independently of management and visibility.
11. **Invitation/activation** — hand identity invitation and activation to the authoritative identity mechanism. Store status/reference only; never store a plaintext password.
12. **Readiness validation** — run the server validator and retain its machine-readable result.
13. **Evidence** — preserve request, step, actor, action, version, and validation references.
14. **Handoff** — transfer ordinary changes to People & Access after Ready / Active.

## Readiness validator

Ready requires all of the following:

- organization is active;
- every requested Location is linked to the organization and active;
- Marketplace installation evidence is present for every operational Location;
- at least one intended Owner or General Manager has an active identity link, active responsibility, and explicit Location access;
- every active Team belongs to its declared Location;
- every requested Sales Manager has one active same-Location management assignment, with no duplicate active manager for a Team;
- intended Sellers have the requested Location access and identity lifecycle state;
- every Team visibility relationship resolves to a Team in an authorized Location;
- every Report-to-Team destination resolves to a Team in an authorized Location;
- mandatory provisioning steps are complete and no mandatory step is failed;
- the final validation transaction records the resulting version and action evidence.

## Partial failure and recovery

1. Leave the request in `Provisioning` or `Failed`; never expose it as Ready.
2. Record only a safe failure summary and the failed step. Keep detailed secrets out of logs and evidence.
3. Correct the failed dependency in the authoritative system.
4. Rerun with the original stable entity identifiers and a new action ID, or replay the same action only when the payload is identical.
5. Revalidate the complete topology. Successful earlier steps are verified and reused, not recreated.
6. If rollback is required, deactivate newly created access and relationships while retaining people, reports, reviews, goals, and audit events.

## First-client boundary

The first V1 client may be provisioned manually by Gaffney using this SOP. Client-facing self-provisioning, direct GHL sub-account creation, password management, and Production promotion are outside V1-C.
