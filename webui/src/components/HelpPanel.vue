<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (event: "update:modelValue", value: boolean): void }>();

const open = computed({
	get: () => props.modelValue,
	set: (value: boolean) => emit("update:modelValue", value),
});

interface HelpRow {
	path: string;
	desc: string;
}

interface HelpSection {
	title: string;
	rows: HelpRow[];
}

const sections: HelpSection[] = [
	{
		title: "全局",
		rows: [
			{ path: ".openplaybook/active-workflow.json", desc: "当前活跃工作流指针，保证同一时间只有一个工作流在跑。" },
			{ path: ".openplaybook/runtime-presets/", desc: "全局运行时预设（模型分配、思考等级）库。" },
			{ path: ".openplaybook/capability-presets/", desc: "全局能力预设（角色人设、技能、产物契约）库。" },
		],
	},
	{
		title: "工作流：.openplaybook/<workflow>/",
		rows: [
			{ path: "state.json", desc: "工作流状态机：当前阶段、状态、各角色运行时状态。" },
			{ path: "channels/<channel>.jsonl", desc: "六个频道的历史消息（control / requirements / architecture / planning / development / review）。" },
			{ path: "inbox/<role>.jsonl", desc: "@提及的私信，每个角色一份。" },
			{ path: "tasks/<phase>/*.md", desc: "阶段任务定义：目标、输入、产出、验收标准。" },
			{ path: "artifacts/", desc: "工作流产物：架构、计划、审查决策、QA 报告等。" },
			{ path: "decisions/", desc: "顺序编号的 ADR（架构决策记录）。" },
			{ path: "summaries/<phase>.md", desc: "阶段总结：目标、关键决策、产物、阻塞。" },
			{ path: "checkpoints/<name>.json", desc: "阶段批准时的快照（含 git commit hash、阶段、状态）。" },
			{ path: "memory/decisions.jsonl", desc: "跨阶段保留的关键决策。" },
			{ path: "memory/user-preferences.jsonl", desc: "用户偏好与口味，避免反复确认。" },
			{ path: "memory/architecture-facts.jsonl", desc: "架构层稳定事实，供后续阶段引用。" },
			{ path: "memory/implementation-notes.jsonl", desc: "实现细节与陷阱备忘。" },
			{ path: "memory/role-lessons.jsonl", desc: "角色复盘：踩坑、改进点。" },
		],
	},
	{
		title: "角色会话：.openplaybook/<workflow>/sessions/<role>/",
		rows: [
			{ path: "status.json", desc: "角色运行时状态（sessionId、status、phase、model）。" },
			{ path: "transcript.jsonl", desc: "角色与系统 / 用户的对话流水。" },
			{ path: "tool-events.jsonl", desc: "角色工具调用、文件改动、错误（敏感值已脱敏）。" },
			{ path: "summary.json", desc: "角色摘要：当前任务、近期决策、阻塞。" },
			{ path: "artifacts/", desc: "该角色独立维护的工件（如果有）。" },
		],
	},
];
</script>

<template>
	<el-drawer
		v-model="open"
		title="目录说明 · .openplaybook"
		size="38%"
		direction="rtl"
		class="opb-help-drawer"
	>
		<div class="opb-help-body">
			<p class="opb-help-intro">
				OpenPlaybook 的所有状态都落在项目根的 <code>.openplaybook/</code> 下。下面是各文件与子目录的职责。
			</p>
			<section v-for="section in sections" :key="section.title" class="opb-help-section">
				<h3 class="opb-help-section__title">{{ section.title }}</h3>
				<div class="opb-help-rows">
					<div v-for="row in section.rows" :key="row.path" class="opb-help-row">
						<code class="opb-help-row__path">{{ row.path }}</code>
						<span class="opb-help-row__desc">{{ row.desc }}</span>
					</div>
				</div>
			</section>
		</div>
	</el-drawer>
</template>
