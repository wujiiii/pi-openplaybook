<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { CHANNELS, channelLabels, channelMentionableRoles, formatTime, roleColors, roleLabels } from "../constants";
import type { ChannelId, ChannelMessage, RoleId } from "../types";

const props = defineProps<{
	selectedChannel: ChannelId;
	messages: ChannelMessage[];
	allowedRoles: RoleId[];
	activeChannel: ChannelId;
	readonly: boolean;
	messageText: string;
}>();

const emit = defineEmits<{
	(event: "update:selectedChannel", channel: ChannelId): void;
	(event: "update:messageText", value: string): void;
	(event: "insert-mention", role: RoleId): void;
	(event: "send"): void;
}>();

const messagesEl = ref<HTMLElement | null>(null);

const currentChannel = computed({
	get: () => props.selectedChannel,
	set: (value: string | number | boolean) => emit("update:selectedChannel", value as ChannelId),
});

const currentMessage = computed({
	get: () => props.messageText,
	set: (value: string) => emit("update:messageText", value),
});

function roleInitials(roleId: string): string {
	return roleId
		.replace(/_/g, " ")
		.split(" ")
		.map((w) => w[0])
		.join("")
		.toUpperCase()
		.slice(0, 2);
}

function getRoleColor(role: string): string {
	return roleColors[role as RoleId] ?? "#4d7eff";
}

function getRoleLabel(role: string): string {
	return roleLabels[role as RoleId] ?? role;
}

const isViewingActiveChannel = computed(() => props.selectedChannel === props.activeChannel);

const composerEnabled = computed(() => {
	if (props.readonly) return false;
	if (isViewingActiveChannel.value) return true;
	// Off-active channel: only "control" stays writable (conservative path).
	return props.selectedChannel === "control";
});

const composerMentions = computed<RoleId[]>(() => {
	const fromChannel = channelMentionableRoles[props.selectedChannel] ?? [];
	const fromPhase = isViewingActiveChannel.value ? props.allowedRoles : [];
	return Array.from(new Set<RoleId>([...fromChannel, ...fromPhase]));
});

watch(
	() => props.messages,
	async () => {
		await nextTick();
		if (messagesEl.value) {
			messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
		}
	},
	{ immediate: true },
);
</script>

<template>
	<div class="opb-workspace">
		<div class="opb-channel-tabs">
			<button
				v-for="channel in CHANNELS"
				:key="channel"
				class="opb-channel-tab"
				:class="{ 'opb-channel-tab--active': currentChannel === channel }"
				@click="currentChannel = channel"
			>
				{{ channelLabels[channel] }}
			</button>
		</div>

		<div ref="messagesEl" class="opb-messages">
			<article
				v-for="message in messages"
				:key="message.id"
				class="opb-message"
				:style="{ '--role-color': getRoleColor(message.from) }"
			>
				<div class="opb-message__avatar">{{ roleInitials(message.from) }}</div>
				<div class="opb-message__content">
					<div class="opb-message__header">
						<span class="opb-message__from">{{ getRoleLabel(message.from) }}</span>
						<span class="opb-message__to">
							→ {{ message.to.length ? message.to.map((r) => getRoleLabel(r)).join("、") : "全频道" }}
						</span>
						<span class="opb-message__time">{{ formatTime(message.ts) }}</span>
					</div>
					<div class="opb-message__body">{{ message.text }}</div>
					<div v-if="message.refs.length" class="opb-message__refs">
						<span v-for="ref in message.refs" :key="ref" class="opb-message__ref">{{ ref }}</span>
					</div>
				</div>
			</article>
		</div>

		<div class="opb-composer">
			<template v-if="composerMentions.length">
				<div class="opb-composer__label">
					{{ isViewingActiveChannel ? "当前阶段可联系角色" : "本频道可联系角色" }}
				</div>
				<div class="opb-composer__mentions">
					<button
						v-for="role in composerMentions"
						:key="role"
						class="opb-composer__mention-btn"
						:disabled="!composerEnabled"
						@click="emit('insert-mention', role)"
					>
						@{{ role }} · {{ roleLabels[role] }}
					</button>
				</div>
			</template>
			<el-input
				v-model="currentMessage"
				type="textarea"
				:rows="3"
				:disabled="!composerEnabled"
				placeholder="输入消息，@role 指定收件方"
				resize="none"
			/>
			<div class="opb-composer__footer">
				<el-button type="primary" size="small" :disabled="!composerEnabled" @click="emit('send')">发送</el-button>
			</div>
		</div>
	</div>
</template>
