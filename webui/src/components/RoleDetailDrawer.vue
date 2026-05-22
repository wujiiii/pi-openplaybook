<script setup lang="ts">
import { computed } from "vue";
import { formatTime, phaseLabels, roleColors, roleLabels, statusLabels } from "../constants";
import type { RoleCompletion, RoleId, RoleResponse } from "../types";

const props = defineProps<{
	modelValue: boolean;
	role: RoleId;
	detail: RoleResponse | null;
	completion: RoleCompletion | null;
	loadingMore?: boolean;
}>();

const emit = defineEmits<{
	(event: "update:modelValue", value: boolean): void;
	(event: "load-more"): void;
}>();

const hasMore = computed(() => props.detail?.nextCursor != null);

const drawerOpen = computed({
	get: () => props.modelValue,
	set: (value: boolean) => emit("update:modelValue", value),
});
</script>

<template>
	<el-drawer v-model="drawerOpen" size="42%" title="角色详情" class="opb-role-drawer">
		<div class="opb-role-drawer__title" :style="{ '--role-color': roleColors[role] }">
			<span class="opb-role-swatch" />
			<div>
				<div class="opb-role-drawer__name">{{ roleLabels[role] }}</div>
				<div class="opb-role-drawer__meta">@{{ role }}</div>
			</div>
		</div>

		<el-descriptions v-if="detail" :column="2" border class="opb-role-descriptions">
			<el-descriptions-item label="运行状态">{{ statusLabels[detail.state.status] }}</el-descriptions-item>
			<el-descriptions-item label="当前模型">{{ detail.state.model ?? "未分配" }}</el-descriptions-item>
			<el-descriptions-item label="阶段">
				{{ detail.state.phase ? phaseLabels[detail.state.phase] : "无" }}
			</el-descriptions-item>
			<el-descriptions-item label="最后更新时间">{{ formatTime(detail.state.lastUpdatedAt) }}</el-descriptions-item>
		</el-descriptions>

		<el-tabs class="opb-role-tabs">
			<el-tab-pane label="摘要与完成信号">
				<el-empty v-if="!completion && !detail" description="暂无角色详情" />
				<div v-else class="opb-role-pane">
					<el-card v-if="completion" shadow="never">
						<template #header>完成信号</template>
						<el-descriptions :column="1" border>
							<el-descriptions-item label="状态">{{ completion.status }}</el-descriptions-item>
							<el-descriptions-item label="阶段">{{ phaseLabels[completion.phase] }}</el-descriptions-item>
							<el-descriptions-item label="需要用户决策">
								{{ completion.needsUserDecision ? "是" : "否" }}
							</el-descriptions-item>
							<el-descriptions-item label="摘要">{{ completion.summary || "无" }}</el-descriptions-item>
							<el-descriptions-item label="引用">{{ completion.refs.join(" / ") || "无" }}</el-descriptions-item>
						</el-descriptions>
					</el-card>

					<el-card v-if="detail" shadow="never">
						<template #header>产物引用</template>
						<el-empty v-if="detail.artifacts.length === 0" description="暂无产物引用" />
						<el-tag v-for="artifact in detail.artifacts" :key="artifact" class="opb-role-artifact-tag">{{ artifact }}</el-tag>
					</el-card>
				</div>
			</el-tab-pane>

			<el-tab-pane label="会话记录">
				<template v-if="detail">
					<div class="opb-role-count">
						{{ detail.transcript.length }} / {{ detail.transcriptTotal }}
					</div>
				</template>
				<el-empty v-if="!detail || detail.transcript.length === 0" description="暂无会话记录" />
				<el-timeline v-else>
					<el-timeline-item v-for="event in detail.transcript" :key="event.id" :timestamp="formatTime(event.ts)">
						<div class="opb-role-event">
							<div class="opb-role-event__kind">{{ event.kind }}</div>
							<div>{{ event.summary }}</div>
						</div>
					</el-timeline-item>
				</el-timeline>
				<div v-if="hasMore" class="opb-role-load-more">
					<el-button :loading="loadingMore" @click="emit('load-more')">加载更多</el-button>
				</div>
			</el-tab-pane>

			<el-tab-pane label="工具事件">
				<template v-if="detail">
					<div class="opb-role-count">
						{{ detail.toolEvents.length }} / {{ detail.toolEventsTotal }}
					</div>
				</template>
				<el-empty v-if="!detail || detail.toolEvents.length === 0" description="暂无工具事件" />
				<el-timeline v-else>
					<el-timeline-item v-for="event in detail.toolEvents" :key="event.id" :timestamp="formatTime(event.ts)">
						<div class="opb-role-event">
							<div class="opb-role-event__kind">{{ event.kind }}</div>
							<div>{{ event.summary }}</div>
						</div>
					</el-timeline-item>
				</el-timeline>
				<div v-if="hasMore" class="opb-role-load-more">
					<el-button :loading="loadingMore" @click="emit('load-more')">加载更多</el-button>
				</div>
			</el-tab-pane>
		</el-tabs>
	</el-drawer>
</template>
