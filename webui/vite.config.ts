import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// Dev-mode proxy target. The openplaybook backend (src/server.ts) chooses its
// port at runtime via OpenPlaybookServer.start(...); override here if it differs.
const DEV_API_TARGET = process.env.OPB_DEV_API ?? "http://127.0.0.1:4717";

export default defineConfig({
	root: __dirname,
	plugins: [vue()],
	build: {
		outDir: "../dist/webui",
		emptyOutDir: true,
		// element-plus alone is ~960kB minified; the split below makes that an
		// isolated, cacheable chunk so the actual app code stays small (<50kB).
		chunkSizeWarningLimit: 1200,
		rollupOptions: {
			output: {
				manualChunks(id: string) {
					if (id.includes("node_modules/element-plus") || id.includes("node_modules/@element-plus/icons-vue")) {
						return "element-plus";
					}
					if (id.includes("node_modules/@vue") || id.includes("node_modules/vue/")) {
						return "vue-vendor";
					}
					return undefined;
				},
			},
		},
	},
	server: {
		proxy: {
			"/api": {
				target: DEV_API_TARGET,
				changeOrigin: false,
			},
		},
	},
});
