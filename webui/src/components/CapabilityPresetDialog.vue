<script setup lang="ts">
import { computed, ref } from "vue";
import { PHASES, ROLE_IDS, phaseLabels, roleLabels, splitLines } from "../constants";
import type { ArtifactSpec, CapabilityPreset, CapabilityPresetLibrary, RoleCapability, RoleId, WorkflowPhase } from "../types";

const props = defineProps<{
	modelValue: boolean;
	library: CapabilityPresetLibrary | null;
}>();

const draft = defineModel<CapabilityPreset | null>("draft", { required: true });

const emit = defineEmits<{
	(event: "update:modelValue", value: boolean): void;
	(event: "select-preset", id: string): void;
	(event: "save"): void;
	(event: "set-default"): void;
}>();

const dialogVisible = computed({
	get: () => props.modelValue,
	set: (value: boolean) => emit("update:modelValue", value),
});

const selectedRole = ref<RoleId>("orchestrator");
const selectedPhase = ref<WorkflowPhase>("requirements_discussion");

function createEmptyCapability(): RoleCapability {
	return {
		persona: "",
		responsibilities: [],
		phasePrompts: {},
		skills: [],
		toolPolicy: { include: [], exclude: [] },
		requiredArtifacts: [],
		outputContract: "",
	};
}

function ensureCapabilityRole(role: RoleId): RoleCapability {
	if (!draft.value) return createEmptyCapability();
	draft.value.config.roles[role] ??= createEmptyCapability();
	return draft.value.config.roles[role];
}

const selectedCapability = computed(() => ensureCapabilityRole(selectedRole.value));
const responsibilitiesText = computed({
	get: () => selectedCapability.value.responsibilities.join("\n"),
	set: (value: string) => {
		selectedCapability.value.responsibilities = splitLines(value);
	},
});
const skillsText = computed({
	get: () => selectedCapability.value.skills.join("\n"),
	set: (value: string) => {
		selectedCapability.value.skills = splitLines(value);
	},
});
const includeToolsText = computed({
	get: () => selectedCapability.value.toolPolicy.include.join("\n"),
	set: (value: string) => {
		selectedCapability.value.toolPolicy.include = splitLines(value);
	},
});
const excludeToolsText = computed({
	get: () => selectedCapability.value.toolPolicy.exclude.join("\n"),
	set: (value: string) => {
		selectedCapability.value.toolPolicy.exclude = splitLines(value);
	},
});
const phasePromptText = computed({
	get: () => selectedCapability.value.phasePrompts[selectedPhase.value] ?? "",
	set: (value: string) => {
		selectedCapability.value.phasePrompts[selectedPhase.value] = value;
	},
});

function addArtifact(): void {
	selectedCapability.value.requiredArtifacts ??= [];
	selectedCapability.value.requiredArtifacts.push({
		path: "artifacts/new-artifact.md",
		owner: selectedRole.value,
		phase: selectedPhase.value,
		description: "请填写产物说明",
	});
}

function removeArtifact(index: number): void {
	selectedCapability.value.requiredArtifacts?.splice(index, 1);
}

function artifactSchemaText(artifact: ArtifactSpec): string {
	return artifact.schema?.required?.join(", ") ?? "";
}

function updateArtifactSchema(artifact: ArtifactSpec, value: string): void {
	const fields = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	artifact.schema = fields.length > 0 ? { required: fields } : undefined;
}

function handlePresetSelect(value: string | number | boolean): void {
	emit("select-preset", String(value));
}

function handleArtifactSchemaUpdate(artifact: ArtifactSpec, value: string | number | boolean): void {
	updateArtifactSchema(artifact, String(value));
}

function handleArtifactSchemaInput(artifact: ArtifactSpec, value: string | number | boolean): void {
	handleArtifactSchemaUpdate(artifact, value);
}
</script>

<template>
	<el-dialog v-model="dialogVisible" title="能力预设" width="1080px" top="4vh">
		<div class="opb-dialog-toolbar">
			<el-select
				:model-value="draft?.id ?? ''"
				placeholder="选择预设"
				style="width: 280px"
				@update:model-value="handlePresetSelect"
			>
				<el-option
					v-for="preset in library?.presets ?? []"
					:key="preset.id"
					:label="preset.name"
					:value="preset.id"
				/>
			</el-select>
			<el-tag v-if="draft && draft.id === library?.defaultPresetId" type="primary" effect="plain">默认预设</el-tag>
		</div>

		<template v-if="draft">
			<el-form label-position="top" class="opb-dialog-form">
				<div class="opb-dialog-form__grid">
					<el-form-item label="预设标识">
						<el-input v-model="draft.id" />
					</el-form-item>
					<el-form-item label="名称">
						<el-input v-model="draft.name" />
					</el-form-item>
				</div>
				<el-form-item label="说明">
					<el-input v-model="draft.description" type="textarea" :rows="2" resize="none" />
				</el-form-item>
			</el-form>

			<div class="opb-capability-layout">
				<el-card shadow="never">
					<template #header>角色范围</template>
					<el-radio-group v-model="selectedRole" class="opb-role-radio-group">
						<el-radio-button v-for="role in ROLE_IDS" :key="role" :label="role">
							{{ roleLabels[role] }}
						</el-radio-button>
					</el-radio-group>
					<el-divider />
					<el-form label-position="top">
						<el-form-item label="角色定位">
							<el-input v-model="selectedCapability.persona" type="textarea" :rows="3" resize="none" />
						</el-form-item>
						<el-form-item label="职责">
							<el-input v-model="responsibilitiesText" type="textarea" :rows="4" resize="none" />
						</el-form-item>
						<el-form-item label="技能">
							<el-input v-model="skillsText" type="textarea" :rows="4" resize="none" />
						</el-form-item>
						<el-form-item label="输出契约">
							<el-input v-model="selectedCapability.outputContract" type="textarea" :rows="3" resize="none" />
						</el-form-item>
					</el-form>
				</el-card>

				<el-card shadow="never">
					<template #header>阶段提示词与工具策略</template>
					<el-form label-position="top">
						<el-form-item label="阶段">
							<el-select v-model="selectedPhase" style="width: 100%">
								<el-option v-for="phase in PHASES" :key="phase" :label="phaseLabels[phase]" :value="phase" />
							</el-select>
						</el-form-item>
						<el-form-item label="当前阶段提示词">
							<el-input v-model="phasePromptText" type="textarea" :rows="5" resize="none" />
						</el-form-item>
						<el-form-item label="允许工具">
							<el-input v-model="includeToolsText" type="textarea" :rows="4" resize="none" />
						</el-form-item>
						<el-form-item label="禁用工具">
							<el-input v-model="excludeToolsText" type="textarea" :rows="3" resize="none" />
						</el-form-item>
					</el-form>
				</el-card>
			</div>

			<el-card shadow="never" class="opb-artifact-card">
				<template #header>
					<div class="opb-card__header">
						<div>
							<div class="opb-section-title">固定产物</div>
							<div class="opb-section-subtitle">按角色和阶段声明产物路径、说明、模板与简易 schema。</div>
						</div>
						<el-button type="primary" plain @click="addArtifact">添加产物</el-button>
					</div>
				</template>

				<el-table :data="selectedCapability.requiredArtifacts ?? []" border stripe>
					<el-table-column label="路径" min-width="240">
						<template #default="{ row }">
							<el-input v-model="row.path" />
						</template>
					</el-table-column>
					<el-table-column label="说明" min-width="220">
						<template #default="{ row }">
							<el-input v-model="row.description" />
						</template>
					</el-table-column>
					<el-table-column label="阶段" width="180">
						<template #default="{ row }">
							<el-select v-model="row.phase" style="width: 100%">
								<el-option v-for="phase in PHASES" :key="phase" :label="phaseLabels[phase]" :value="phase" />
							</el-select>
						</template>
					</el-table-column>
					<el-table-column label="模板" min-width="180">
						<template #default="{ row }">
							<el-input v-model="row.template" />
						</template>
					</el-table-column>
					<el-table-column label="Schema(required)" min-width="180">
						<template #default="{ row }">
							<el-input :model-value="artifactSchemaText(row)" @update:model-value="handleArtifactSchemaInput(row, $event)" />
						</template>
					</el-table-column>
					<el-table-column label="操作" width="90" fixed="right">
						<template #default="{ $index }">
							<el-button type="danger" link @click="removeArtifact($index)">移除</el-button>
						</template>
					</el-table-column>
				</el-table>
			</el-card>
		</template>

		<template #footer>
			<el-button @click="dialogVisible = false">关闭</el-button>
			<el-button @click="emit('set-default')">设为默认</el-button>
			<el-button type="primary" @click="emit('save')">保存预设</el-button>
		</template>
	</el-dialog>
</template>
