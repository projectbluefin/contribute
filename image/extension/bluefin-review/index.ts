/**
 * Bluefin policy adapter for the generic Hive Workbench core.
 *
 * The package edge selects Bluefin repository policy. The workbench itself
 * stays generic and uses OMP for execution and Hive for queue authority.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { type ReviewExtensionHost, createReviewExtension } from "./extension.ts";
import { BLUEFIN_POLICY } from "./policy.ts";

export default function bluefinReviewExtension(pi: ReviewExtensionHost): void {
	createReviewExtension(pi, {
		matchKey: (data, key) => matchesKey(data, key as KeyId),
		policy: BLUEFIN_POLICY,
	});
}
