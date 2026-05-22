<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type { CapabilityPresetLibrary, RuntimePresetLibrary } from "../types";

const props = defineProps<{
	modelValue: boolean;
	runtimeLibrary: RuntimePresetLibrary | null;
	capabilityLibrary: CapabilityPresetLibrary | null;
	isBusy: boolean;
}>();

const emit = defineEmits<{
	(event: "update:modelValue", value: boolean): void;
	(
		event: "submit",
		payload: {
			id: string;
			displayName: string;
			runtimePresetId?: string;
			capabilityPresetId?: string;
		},
	): void;
}>();

const dialogVisible = computed({
	get: () => props.modelValue,
	set: (value: boolean) => emit("update:modelValue", value),
});

const form = reactive({
	id: "",
	displayName: "",
	runtimePresetId: "",
	capabilityPresetId: "",
});

watch(
	() => props.modelValue,
	(value) => {
		if (!value) return;
		form.id = "";
		form.displayName = "";
		form.runtimePresetId = props.runtimeLibrary?.defaultPresetId ?? "";
		form.capabilityPresetId = props.capabilityLibrary?.defaultPresetId ?? "";
	},
	{ immediate: true },
);

function submit(): void {
	emit("submit", {
		id: form.id.trim(),
		displayName: form.displayName.trim(),
		runtimePresetId: form.runtimePresetId || undefined,
		capabilityPresetId: form.capabilityPresetId || undefined,
	});
}
</script>

<template>
	<el-dialog v-model="dialogVisible" title="新建工作流" width="560px">
		<el-form label-position="top">
			<el-form-item label="工作流名称">
				<el-input v-model="form.displayName" placeholder="例如：订单系统需求协作" />
			</el-form-item>
			<el-form-item label="内部标识">
				<el-input v-model="form.id" placeholder="例如：order-system-discovery" />
			</el-form-item>
			<el-form-item label="运行时预设">
				<el-select v-model="form.runtimePresetId" style="width: 100%">
					<el-option
						v-for="preset in runtimeLibrary?.presets ?? []"
						:key="preset.id"
						:label="preset.name"
						:value="preset.id"
					/>
				</el-select>
			</el-form-item>
			<el-form-item label="能力预设">
				<el-select v-model="form.capabilityPresetId" style="width: 100%">
					<el-option
						v-for="preset in capabilityLibrary?.presets ?? []"
						:key="preset.id"
						:label="preset.name"
						:value="preset.id"
					/>
				</el-select>
			</el-form-item>
		</el-form>

		<template #footer>
			<el-button @click="dialogVisible = false">取消</el-button>
			<el-button type="primary" :loading="isBusy" @click="submit">创建并启动</el-button>
		</template>
	</el-dialog>
</template>
