<script setup lang="ts">
import { computed } from "vue";
import { ROLE_IDS, roleLabels } from "../constants";
import type { RoleModelAssignment, RuntimeModelOption, RuntimePreset, RuntimePresetLibrary } from "../types";

const props = defineProps<{
	modelValue: boolean;
	library: RuntimePresetLibrary | null;
	models: RuntimeModelOption[];
	adjusted: boolean;
}>();

const draft = defineModel<RuntimePreset | null>("draft", { required: true });

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

const modelOptions = computed(() =>
	props.models.map((model) => ({
		label: `${model.providerName} / ${model.name}`,
		value: model.ref,
	})),
);

function ensureRole(role: (typeof ROLE_IDS)[number]): void {
	if (!draft.value) return;
	draft.value.config.roles[role] ??= {
		model: draft.value.config.defaultModel ?? props.models[0]?.ref ?? "",
	};
}

function handlePresetSelect(value: string | number | boolean): void {
	emit("select-preset", String(value));
}

function updateRoleModel(role: (typeof ROLE_IDS)[number], value: string | number | boolean): void {
	ensureRole(role);
	if (!draft.value) return;
	draft.value.config.roles[role]!.model = String(value);
}

function updateThinkingLevel(role: (typeof ROLE_IDS)[number], value: string | number | boolean): void {
	ensureRole(role);
	if (!draft.value) return;
	const thinkingLevel = String(value);
	draft.value.config.roles[role]!.thinkingLevel = thinkingLevel
		? (thinkingLevel as RoleModelAssignment["thinkingLevel"])
		: undefined;
}
</script>

<template>
	<el-dialog v-model="dialogVisible" title="运行时预设" width="980px">
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

		<el-alert
			v-if="adjusted"
			type="info"
			show-icon
			:closable="false"
			title="已根据当前登录供应商自动调整为可用模型，保存后会写入当前预览值。"
			class="opb-dialog-alert"
		/>

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
				<div class="opb-dialog-form__grid">
					<el-form-item label="模式">
						<el-input value="real" disabled />
					</el-form-item>
					<el-form-item label="默认模型">
						<el-select v-model="draft.config.defaultModel" style="width: 100%">
							<el-option v-for="model in modelOptions" :key="model.value" :label="model.label" :value="model.value" />
						</el-select>
					</el-form-item>
				</div>
			</el-form>

			<div class="opb-runtime-role-grid">
				<div class="opb-runtime-role-grid__head">
					<span>角色</span>
					<span>模型</span>
					<span>思考等级</span>
				</div>
				<div v-for="role in ROLE_IDS" :key="role" class="opb-runtime-role-grid__row">
					<div>{{ roleLabels[role] }}</div>
					<el-select
						:model-value="draft.config.roles[role]?.model ?? ''"
						style="width: 100%"
						@focus="ensureRole(role)"
						@update:model-value="updateRoleModel(role, $event)"
					>
						<el-option v-for="model in modelOptions" :key="model.value" :label="model.label" :value="model.value" />
					</el-select>
					<el-select
						:model-value="draft.config.roles[role]?.thinkingLevel ?? ''"
						style="width: 100%"
						@focus="ensureRole(role)"
						@update:model-value="updateThinkingLevel(role, $event)"
					>
						<el-option label="默认" value="" />
						<el-option label="off" value="off" />
						<el-option label="minimal" value="minimal" />
						<el-option label="low" value="low" />
						<el-option label="medium" value="medium" />
						<el-option label="high" value="high" />
						<el-option label="max" value="max" />
					</el-select>
				</div>
			</div>
		</template>

		<template #footer>
			<el-button @click="dialogVisible = false">关闭</el-button>
			<el-button @click="emit('set-default')">设为默认</el-button>
			<el-button type="primary" @click="emit('save')">保存预设</el-button>
		</template>
	</el-dialog>
</template>
