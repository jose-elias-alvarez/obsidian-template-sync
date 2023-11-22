import { detailedDiff } from "deep-object-diff";
import {
	FrontMatterCache,
	Notice,
	Plugin,
	TFile,
	normalizePath,
} from "obsidian";

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: "default",
};

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	frontmatterCache: Record<string, FrontMatterCache> = {};

	async isTemplate(file: TFile) {
		let templatesConfig: string;
		try {
			templatesConfig = await this.app.vault.adapter.read(
				normalizePath(this.app.vault.configDir + "/templates.json")
			);
		} catch {
			throw new Error(
				"Failed to read templates config. Make sure the core plugin is enabled."
			);
		}

		let templatesFolder: string;
		try {
			templatesFolder = JSON.parse(templatesConfig).folder;
		} catch {
			throw new Error(
				"Failed to get templates folder from templates config. Make sure you've configured a template folder location in the core plugin's settings."
			);
		}
		return file.path.startsWith(templatesFolder);
	}

	applyDiff(obj: any, diff: any) {
		const result = obj;

		const applyRecursively = (target: any, change: any) => {
			for (const key in change) {
				if (change[key] && typeof change[key] === "object") {
					if (!target[key]) {
						target[key] = Array.isArray(change[key]) ? [] : {};
					}
					applyRecursively(target[key], change[key]);
				} else {
					if (change[key] === null) {
						delete target[key];
					} else {
						target[key] = change[key];
					}
				}
			}
		};

		applyRecursively(result, diff.added);
		applyRecursively(result, diff.updated);
		applyRecursively(result, diff.deleted);

		return result;
	}

	async onload() {
		await this.loadSettings();

		this.app.workspace.onLayoutReady(() => {
			// vault events happen before metadata cache events,
			// so we listen so that we can diff the old and new frontmatter
			this.app.vault.on("modify", async (file) => {
				if (!(file instanceof TFile)) return;
				if (!(await this.isTemplate(file))) return;

				const frontmatter =
					this.app.metadataCache.getFileCache(file)?.frontmatter;
				if (!frontmatter) return;

				this.frontmatterCache[file.path] = frontmatter;
			});
			this.app.vault.on("rename", async (file, oldPath) => {
				delete this.frontmatterCache[oldPath];

				if (!(file instanceof TFile)) return;
				if (!(await this.isTemplate(file))) return;

				const cache = this.app.metadataCache.getFileCache(file);
				if (!cache?.frontmatter) return;
				this.frontmatterCache[file.path] = cache.frontmatter;
			});
			this.app.vault.on("delete", async (file) => {
				delete this.frontmatterCache[file.path];
			});

			this.app.metadataCache.on("changed", async (file) => {
				if (!(file instanceof TFile)) return;
				if (!(await this.isTemplate(file))) return;

				const oldFrontmatter = this.frontmatterCache[file.path];
				const newFrontmatter =
					this.app.metadataCache.getFileCache(file)?.frontmatter;
				if (!(oldFrontmatter && newFrontmatter)) return;

				const diff = detailedDiff(oldFrontmatter, newFrontmatter);
				console.log(diff);
				if (!diff) return;

				// use undocumented API to get the template's backlinks
				const linkedFiles = Object.keys(
					// @ts-ignore
					this.app.metadataCache.getBacklinksForFile(file).data
				)
					.map((link) => this.app.vault.getAbstractFileByPath(link))
					.filter((file): file is TFile => file instanceof TFile);
				if (!linkedFiles.length) return;

				// at this point, we know these files have a backlink to the template
				// but we don't know that that link is in the frontmatter template field
				let updateCount = 0;
				for await (const linkedFile of linkedFiles) {
					const cache =
						this.app.metadataCache.getFileCache(linkedFile);
					if (!cache) continue;

					const hasLink = cache.frontmatterLinks?.some(
						(link) =>
							link.key === "template" &&
							this.app.metadataCache.getFirstLinkpathDest(
								link.link,
								linkedFile.path
							) === file
					);
					if (!hasLink) continue;

					await this.app.fileManager.processFrontMatter(
						linkedFile,
						(frontmatter) => this.applyDiff(frontmatter, diff)
					);
					updateCount++;
				}

				if (!updateCount) return;
				new Notice(
					`Updated ${updateCount} file(s) linked to ${file.basename}`
				);
			});
		});
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
