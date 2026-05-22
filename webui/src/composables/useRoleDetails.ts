import { computed, ref } from "vue";
import { getRole, getRoleCompletion } from "../api";
import type { RoleCompletion, RoleId, RoleResponse } from "../types";

export function useRoleDetails() {
	const drawerOpen = ref(false);
	const selectedRole = ref<RoleId>("orchestrator");
	const selectedCompletion = ref<RoleCompletion | null>(null);
	const roleDetails = ref<Partial<Record<RoleId, RoleResponse>>>({});
	const loadingMore = ref(false);

	const selectedRoleDetail = computed(() => roleDetails.value[selectedRole.value]);

	async function open(workflowId: string, role: RoleId): Promise<void> {
		selectedRole.value = role;
		const [detail, completion] = await Promise.all([
			getRole(workflowId, role),
			getRoleCompletion(workflowId, role).catch(() => null),
		]);
		roleDetails.value = { ...roleDetails.value, [role]: detail };
		selectedCompletion.value = completion;
		drawerOpen.value = true;
	}

	async function loadMore(workflowId: string, role: RoleId): Promise<void> {
		const current = roleDetails.value[role];
		if (!current || current.nextCursor == null || loadingMore.value) return;
		loadingMore.value = true;
		try {
			const next = await getRole(workflowId, role, current.nextCursor);
			roleDetails.value = {
				...roleDetails.value,
				[role]: {
					...next,
					transcript: [...current.transcript, ...next.transcript],
					toolEvents: [...current.toolEvents, ...next.toolEvents],
				},
			};
		} finally {
			loadingMore.value = false;
		}
	}

	function close(): void {
		drawerOpen.value = false;
	}

	return {
		close,
		drawerOpen,
		loadingMore,
		loadMore,
		open,
		roleDetails,
		selectedCompletion,
		selectedRole,
		selectedRoleDetail,
	};
}
