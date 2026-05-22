<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
	getArtifacts,
	getChannel,
	getCheckpoints,
	getMemory,
	getPhaseContext,
	runAction,
	sendMessage,
} from "./api";
import { PHASES, phaseLabels, roleLabels } from "./constants";
import CapabilityPresetDialog from "./components/CapabilityPresetDialog.vue";
import ChannelWorkspace from "./components/ChannelWorkspace.vue";
import HelpPanel from "./components/HelpPanel.vue";
import RoleDetailDrawer from "./components/RoleDetailDrawer.vue";
import RoleStatusRail from "./components/RoleStatusRail.vue";
import RuntimePresetDialog from "./components/RuntimePresetDialog.vue";
import WorkflowCreateDialog from "./components/WorkflowCreateDialog.vue";
import WorkflowHeader from "./components/WorkflowHeader.vue";
import { usePresets } from "./composables/usePresets";
import { useRoleDetails } from "./composables/useRoleDetails";
import { useWorkflows } from "./composables/useWorkflows";
import type {
	ChannelId,
	ChannelMessage,
	CheckpointMetadata,
	OpenPlaybookApiCreateWorkflowRequest,
	OpenPlaybookApiPhaseContextResponse,
	RoleId,
	WorkflowMemoryEntry,
} from "./types";

interface ArtifactListItem {
	path?: string;
	status?: string;
	owner?: string;
	phase?: string;
	description?: string;
}

const {
	activeWorkflowId,
	create,
	refresh: refreshWorkflows,
	selectedWorkflow,
	selectedWorkflowId,
	workflows,
} = useWorkflows();
const {
	capabilityDraft,
	capabilityLibrary,
	makeCapabilityDefault,
	makeRuntimeDefault,
	refresh: refreshPresets,
	runtimeDraft,
	runtimeDraftAdjusted,
	runtimeLibrary,
	runtimeModels,
	saveCapability,
	saveRuntime,
	selectCapabilityPreset,
	selectRuntimePreset,
} = usePresets();
const {
	drawerOpen,
	loadingMore: roleLoadingMore,
	loadMore: loadRoleMore,
	open: openRoleDetail,
	selectedCompletion,
	selectedRole,
	selectedRoleDetail,
} = useRoleDetails();

const selectedChannel = ref<ChannelId>("control");
const messages = ref<ChannelMessage[]>([]);
const phaseContext = ref<OpenPlaybookApiPhaseContextResponse | null>(null);
const artifacts = ref<ArtifactListItem[]>([]);
const memories = ref<WorkflowMemoryEntry[]>([]);
const checkpoints = ref<CheckpointMetadata[]>([]);
const messageText = ref("");
const isBusy = ref(false);
const createDialogOpen = ref(false);
const runtimeDialogOpen = ref(false);
const capabilityDialogOpen = ref(false);
const helpPanelOpen = ref(false);
const summaryTab = ref<"artifacts" | "memory" | "checkpoints">("artifacts");

const currentPhaseIndex = computed(() => {
	const phase = phaseContext.value?.phase;
	return phase ? PHASES.indexOf(phase) : -1;
});
const currentPhaseLabel = computed(() =>
	phaseContext.value ? phaseLabels[phaseContext.value.phase] : "未进入阶段",
);
const orderedRoles = computed(() => {
	const roleStates = phaseContext.value?.roleStates ?? {};
	const allowed = new Set(phaseContext.value?.allowedRoles ?? []);
	return Object.keys(roleStates)
		.filter((role): role is RoleId => role in roleLabels)
		.sort((left, right) => {
			const allowedGap = Number(allowed.has(right)) - Number(allowed.has(left));
			if (allowedGap !== 0) return allowedGap;
			return roleLabels[left].localeCompare(roleLabels[right], "zh-CN");
	});
});

function getPhaseLabel(phase: keyof typeof phaseLabels): string {
	return phaseLabels[phase];
}

async function withBusy(task: () => Promise<void>): Promise<void> {
	isBusy.value = true;
	try {
		await task();
	} catch (error) {
		ElMessage.error(error instanceof Error ? error.message : String(error));
	} finally {
		isBusy.value = false;
	}
}

async function refreshAll(): Promise<void> {
	await withBusy(async () => {
		await Promise.all([refreshWorkflows(), refreshPresets()]);
		if (selectedWorkflowId.value) {
			await loadWorkflow(selectedWorkflowId.value);
		}
	});
}

async function loadWorkflow(workflowId: string): Promise<void> {
	selectedWorkflowId.value = workflowId;
	const context = await getPhaseContext(workflowId);
	phaseContext.value = context;
	selectedChannel.value = context.channel;
	await Promise.all([loadChannel(context.channel), loadWorkflowPanels()]);
	if (drawerOpen.value) {
		await openRoleDetail(workflowId, selectedRole.value);
	}
}

async function loadChannel(channel = selectedChannel.value): Promise<void> {
	if (!selectedWorkflowId.value) return;
	selectedChannel.value = channel;
	messages.value = (await getChannel(selectedWorkflowId.value, channel)).items;
}

async function loadWorkflowPanels(): Promise<void> {
	if (!selectedWorkflowId.value) return;
	const [artifactPayload, memoryPayload, checkpointPayload] = await Promise.all([
		getArtifacts(selectedWorkflowId.value).catch(() => ({ items: [] })),
		getMemory(selectedWorkflowId.value).catch(() => ({ items: [] })),
		getCheckpoints(selectedWorkflowId.value).catch(() => ({ items: [] })),
	]);
	artifacts.value = artifactPayload.items as ArtifactListItem[];
	memories.value = memoryPayload.items;
	checkpoints.value = checkpointPayload.items;
}

async function handleWorkflowSwitch(workflowId: string): Promise<void> {
	await withBusy(async () => {
		await loadWorkflow(workflowId);
	});
}

async function handleCreateWorkflow(payload: OpenPlaybookApiCreateWorkflowRequest): Promise<void> {
	if (!payload.id.trim()) {
		ElMessage.warning("请填写内部标识。");
		return;
	}
	if (!payload.displayName.trim()) {
		ElMessage.warning("请填写工作流名称。");
		return;
	}
	await withBusy(async () => {
		await create(payload);
		createDialogOpen.value = false;
		ElMessage.success("工作流已创建并启动。");
		await loadWorkflow(payload.id);
	});
}

async function submitMessage(): Promise<void> {
	const message = messageText.value.trim();
	if (!selectedWorkflowId.value || !message) return;
	await withBusy(async () => {
		await sendMessage(selectedWorkflowId.value, message, selectedChannel.value);
		messageText.value = "";
		ElMessage.success("消息已发送。");
		await loadChannel();
		await loadWorkflow(selectedWorkflowId.value);
	});
}

async function submitAction(action: "approve" | "next" | "close" | "revise"): Promise<void> {
	if (!selectedWorkflowId.value) return;
	let reason: string | undefined;
	if (action === "revise") {
		try {
			const result = await ElMessageBox.prompt("请输入修订原因", "修订当前阶段", {
				confirmButtonText: "提交修订",
				cancelButtonText: "取消",
				inputPlaceholder: "请说明需要回改的点",
			});
			reason = result.value.trim();
			if (!reason) return;
		} catch {
			return;
		}
	}
	await withBusy(async () => {
		await runAction(selectedWorkflowId.value, action, reason);
		ElMessage.success("操作已执行。");
		await refreshAll();
	});
}

async function openRole(role: RoleId): Promise<void> {
	if (!selectedWorkflowId.value) return;
	await withBusy(async () => {
		await openRoleDetail(selectedWorkflowId.value, role);
	});
}

async function loadMoreRoleEvents(): Promise<void> {
	if (!selectedWorkflowId.value) return;
	await loadRoleMore(selectedWorkflowId.value, selectedRole.value);
}

function insertMention(role: RoleId): void {
	const mention = `@${role} `;
	if (!messageText.value.includes(mention)) {
		messageText.value = `${mention}${messageText.value}`.trimStart();
	}
}

async function persistRuntimePreset(): Promise<void> {
	await withBusy(async () => {
		await saveRuntime();
		ElMessage.success("运行时预设已保存。");
	});
}

async function persistCapabilityPreset(): Promise<void> {
	await withBusy(async () => {
		await saveCapability();
		ElMessage.success("能力预设已保存。");
	});
}

async function setRuntimeDefault(): Promise<void> {
	await withBusy(async () => {
		await makeRuntimeDefault();
		ElMessage.success("默认运行时预设已更新。");
	});
}

async function setCapabilityDefault(): Promise<void> {
	await withBusy(async () => {
		await makeCapabilityDefault();
		ElMessage.success("默认能力预设已更新。");
	});
}

onMounted(() => {
	void refreshAll();
});
</script>

<template>
	<el-config-provider namespace="el">
		<div class="opb-app-shell">
			<!-- ── Header ── -->
			<workflow-header
				:workflows="workflows"
				:selected-workflow-id="selectedWorkflowId"
				:current-workflow="selectedWorkflow"
				:current-phase-label="currentPhaseLabel"
				@select-workflow="handleWorkflowSwitch"
				@open-create="createDialogOpen = true"
				@open-runtime-presets="runtimeDialogOpen = true"
				@open-capability-presets="capabilityDialogOpen = true"
				@open-help="helpPanelOpen = true"
				@approve="submitAction('approve')"
				@next="submitAction('next')"
				@revise="submitAction('revise')"
				@close="submitAction('close')"
				@refresh="refreshAll"
			/>

			<!-- ── Phase stepper ── -->
			<div class="opb-phase-bar">
				<div class="opb-phase-steps">
					<template v-for="(phase, index) in PHASES" :key="phase">
						<div
							v-if="index > 0"
							class="opb-phase-connector"
							:class="{ 'opb-phase-connector--passed': index <= currentPhaseIndex }"
						/>
						<div
							class="opb-phase-step"
							:class="{
								'opb-phase-step--active': phase === phaseContext?.phase,
								'opb-phase-step--passed': index < currentPhaseIndex,
							}"
						>
							<div class="opb-phase-step__content">
								<div class="opb-phase-step__num">{{ index + 1 }}</div>
								<div class="opb-phase-step__label">{{ phaseLabels[phase] }}</div>
							</div>
						</div>
					</template>
				</div>
			</div>

			<!-- ── 3-column main grid ── -->
			<div class="opb-main-grid">
				<!-- Left: Role status rail -->
				<div class="opb-main-grid__roles">
					<role-status-rail
						:ordered-roles="orderedRoles"
						:allowed-roles="phaseContext?.allowedRoles ?? []"
						:role-states="phaseContext?.roleStates ?? {}"
						@open-role="openRole"
					/>
				</div>

				<!-- Center: Channel workspace -->
				<div class="opb-main-grid__content">
					<channel-workspace
						v-model:selected-channel="selectedChannel"
						v-model:message-text="messageText"
						:messages="messages"
						:allowed-roles="phaseContext?.allowedRoles ?? []"
						:active-channel="phaseContext?.channel ?? 'control'"
						:readonly="phaseContext?.readonly ?? true"
						@update:selected-channel="loadChannel"
						@insert-mention="insertMention"
						@send="submitMessage"
					/>
				</div>

				<!-- Right: Summary panel -->
				<div class="opb-main-grid__panel">
					<div class="opb-summary">
						<div class="opb-summary__header">
							<span class="opb-summary__title">工作区摘要</span>
							<div class="opb-summary__tabs">
								<button
									class="opb-summary__tab"
									:class="{ 'opb-summary__tab--active': summaryTab === 'artifacts' }"
									@click="summaryTab = 'artifacts'"
								>产物</button>
								<button
									class="opb-summary__tab"
									:class="{ 'opb-summary__tab--active': summaryTab === 'memory' }"
									@click="summaryTab = 'memory'"
								>记忆</button>
								<button
									class="opb-summary__tab"
									:class="{ 'opb-summary__tab--active': summaryTab === 'checkpoints' }"
									@click="summaryTab = 'checkpoints'"
								>检查点</button>
							</div>
						</div>
						<div class="opb-summary__content">
							<el-table v-if="summaryTab === 'artifacts'" :data="artifacts" size="small">
								<el-table-column prop="path" label="路径" min-width="110" show-overflow-tooltip />
								<el-table-column prop="status" label="状态" width="64" show-overflow-tooltip />
								<el-table-column prop="owner" label="角色" width="72" show-overflow-tooltip />
							</el-table>
							<el-table v-else-if="summaryTab === 'memory'" :data="memories.slice(0, 8)" size="small">
								<el-table-column prop="scope" label="范围" width="72" />
								<el-table-column prop="text" label="内容" min-width="140" show-overflow-tooltip />
							</el-table>
							<el-table v-else :data="checkpoints" size="small">
								<el-table-column prop="name" label="名称" min-width="100" show-overflow-tooltip />
								<el-table-column label="阶段" width="72" show-overflow-tooltip>
									<template #default="{ row }">{{ getPhaseLabel(row.phase) }}</template>
								</el-table-column>
								<el-table-column prop="createdAt" label="时间" width="88" show-overflow-tooltip />
							</el-table>
						</div>
					</div>
				</div>
			</div>

			<!-- ── Dialogs ── -->
			<workflow-create-dialog
				v-model="createDialogOpen"
				:runtime-library="runtimeLibrary"
				:capability-library="capabilityLibrary"
				:is-busy="isBusy"
				@submit="handleCreateWorkflow"
			/>
			<runtime-preset-dialog
				v-model="runtimeDialogOpen"
				v-model:draft="runtimeDraft"
				:library="runtimeLibrary"
				:models="runtimeModels"
				:adjusted="runtimeDraftAdjusted"
				@select-preset="selectRuntimePreset"
				@save="persistRuntimePreset"
				@set-default="setRuntimeDefault"
			/>
			<capability-preset-dialog
				v-model="capabilityDialogOpen"
				v-model:draft="capabilityDraft"
				:library="capabilityLibrary"
				@select-preset="selectCapabilityPreset"
				@save="persistCapabilityPreset"
				@set-default="setCapabilityDefault"
			/>
			<role-detail-drawer
				v-model="drawerOpen"
				:role="selectedRole"
				:detail="selectedRoleDetail ?? null"
				:completion="selectedCompletion"
				:loading-more="roleLoadingMore"
				@load-more="loadMoreRoleEvents"
			/>
			<help-panel v-model="helpPanelOpen" />
		</div>
	</el-config-provider>
</template>
