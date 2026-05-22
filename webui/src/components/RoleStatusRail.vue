<script setup lang="ts">
import { roleColors, roleLabels, statusLabels } from "../constants";
import type { RoleId, RoleRuntimeState } from "../types";

defineProps<{
	orderedRoles: RoleId[];
	allowedRoles: RoleId[];
	roleStates: Partial<Record<RoleId, RoleRuntimeState>>;
}>();

const emit = defineEmits<{
	(event: "open-role", role: RoleId): void;
}>();
</script>

<template>
	<div class="opb-role-rail">
		<div class="opb-role-rail__header">
			<span class="opb-role-rail__title">角色状态</span>
		</div>
		<div class="opb-role-list">
			<button
				v-for="role in orderedRoles"
				:key="role"
				type="button"
				class="opb-role-item"
				:class="{ 'opb-role-item--active': allowedRoles.includes(role) }"
				:style="{ '--role-color': roleColors[role] }"
				@click="emit('open-role', role)"
			>
				<div class="opb-role-indicator" />
				<div class="opb-role-item__body">
					<div class="opb-role-item__name">{{ roleLabels[role] }}</div>
					<div class="opb-role-item__status">{{ statusLabels[roleStates[role]?.status ?? "not_started"] }}</div>
				</div>
				<span v-if="allowedRoles.includes(role)" class="opb-role-item__badge">当前</span>
			</button>
		</div>
	</div>
</template>
