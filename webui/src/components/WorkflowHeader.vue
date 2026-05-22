<script setup lang="ts">
import type { WorkflowItem } from "../types";

defineProps<{
	workflows: WorkflowItem[];
	selectedWorkflowId: string;
	currentWorkflow: WorkflowItem | null;
	currentPhaseLabel: string;
}>();

const emit = defineEmits<{
	(event: "select-workflow", workflowId: string): void;
	(event: "open-create"): void;
	(event: "open-runtime-presets"): void;
	(event: "open-capability-presets"): void;
	(event: "open-help"): void;
	(event: "approve"): void;
	(event: "next"): void;
	(event: "revise"): void;
	(event: "close"): void;
	(event: "refresh"): void;
}>();

function handleWorkflowSelect(value: string | number | boolean): void {
	emit("select-workflow", String(value));
}
</script>

<template>
	<header class="opb-header">
		<div class="opb-header__brand">
			<div class="opb-header__logo">P</div>
			<span class="opb-header__title">OpenPlaybook</span>
		</div>

		<div class="opb-header__workflow">
			<template v-if="currentWorkflow">
				<h1 class="opb-header__workflow-name">{{ currentWorkflow.displayName }}</h1>
				<div class="opb-header__phase-badge">
					<span class="opb-header__phase-dot" />
					{{ currentPhaseLabel }}
				</div>
				<div class="opb-header__workflow-meta">
					{{ currentWorkflow.id }} / {{ currentWorkflow.status }}
				</div>
			</template>
			<div v-else class="opb-header__empty">
				<span class="opb-header__empty-title">未选择工作流</span>
				<span class="opb-header__empty-hint">从右侧切换器选择，或点击「新建工作流」</span>
			</div>
		</div>

		<div class="opb-header__switcher">
			<el-select
				:model-value="selectedWorkflowId"
				placeholder="切换工作流"
				size="small"
				style="width: 220px"
				filterable
				@update:model-value="handleWorkflowSelect"
			>
				<el-option
					v-for="workflow in workflows"
					:key="workflow.id"
					:label="workflow.displayName"
					:value="workflow.id"
				>
					<div class="opb-header__option">
						<span>{{ workflow.displayName }}</span>
						<small>{{ workflow.id }}</small>
					</div>
				</el-option>
			</el-select>
		</div>

		<div class="opb-header__actions">
			<el-button size="small" @click="emit('refresh')">刷新</el-button>
			<el-button size="small" @click="emit('open-runtime-presets')">运行时</el-button>
			<el-button size="small" @click="emit('open-capability-presets')">能力预设</el-button>
			<el-button size="small" type="primary" @click="emit('open-create')">新建工作流</el-button>
		</div>

		<div class="opb-header__stage-actions">
			<el-button size="small" @click="emit('approve')">批准</el-button>
			<el-button size="small" @click="emit('next')">推进</el-button>
			<el-button size="small" @click="emit('revise')">修订</el-button>
			<el-button size="small" type="danger" plain @click="emit('close')">关闭</el-button>
		</div>

		<div class="opb-header__help">
			<el-button size="small" circle title="目录说明" @click="emit('open-help')">?</el-button>
		</div>
	</header>
</template>
