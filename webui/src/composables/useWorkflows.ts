import { computed, ref } from "vue";
import { createWorkflow, getWorkflows } from "../api";
import type { OpenPlaybookApiCreateWorkflowRequest, WorkflowItem } from "../types";

export function useWorkflows() {
	const workflows = ref<WorkflowItem[]>([]);
	const activeWorkflowId = ref<string | null>(null);
	const selectedWorkflowId = ref("");

	const selectedWorkflow = computed(
		() => workflows.value.find((workflow) => workflow.id === selectedWorkflowId.value) ?? null,
	);

	async function refresh(): Promise<void> {
		const payload = await getWorkflows();
		workflows.value = payload.workflows;
		activeWorkflowId.value = payload.activeWorkflowId;
		if (!selectedWorkflowId.value || !workflows.value.some((workflow) => workflow.id === selectedWorkflowId.value)) {
			selectedWorkflowId.value = payload.activeWorkflowId ?? payload.workflows[0]?.id ?? "";
		}
	}

	async function create(payload: OpenPlaybookApiCreateWorkflowRequest): Promise<void> {
		await createWorkflow(payload);
		await refresh();
		selectedWorkflowId.value = payload.id;
	}

	return {
		activeWorkflowId,
		create,
		refresh,
		selectedWorkflow,
		selectedWorkflowId,
		workflows,
	};
}
