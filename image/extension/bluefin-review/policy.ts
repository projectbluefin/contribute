export interface ManagedRepoPolicy {
	readonly repository: string;
	readonly requiredLabels: readonly string[];
	readonly deniedLabels: readonly string[];
}

export interface WorkbenchPolicy {
	readonly managedRepositories: readonly ManagedRepoPolicy[];
}

export const GENERIC_WORKBENCH_POLICY: WorkbenchPolicy = {
	managedRepositories: [],
};

export const BLUEFIN_POLICY: WorkbenchPolicy = {
	managedRepositories: [
		{ repository: "projectbluefin/review", requiredLabels: ["3-clanker-queue"], deniedLabels: ["hold", "blocked"] },
		{ repository: "projectbluefin/documentation", requiredLabels: ["3-docs-queue"], deniedLabels: ["hold"] },
	],
};

export function managedPolicyFor(repo: string, policy: WorkbenchPolicy): ManagedRepoPolicy | undefined {
	return policy.managedRepositories.find((candidate) => candidate.repository === repo);
}
