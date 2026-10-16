import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DETECT_WIDTH,
	HIDDEN_SECTION_NAMES,
	SECTION_PRUNER_KEY,
	findLoadedResourcesContainer,
	hideLoadedSections,
	installHiddenSectionPruner,
	isBlankLineComponent,
	isHiddenSection,
	pruneHiddenSections,
	releaseHiddenSectionPruner,
	sectionTitleOfLine,
} from "./loaded-sections.ts";

/** The minimal fake component / container — shaped after pi-tui's Container / Text / Spacer. */
class FakeSection {
	name: string;
	constructor(name: string) {
		this.name = name;
	}
	render(_width: number): string[] {
		return [`\u001b[38;2;121;214;193m[${this.name}]\u001b[39m`, `  ${this.name}'s content`, ""];
	}
}

class FakeSpacer {
	render(_width: number): string[] {
		return [""];
	}
}

class FakeText {
	text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(_width: number): string[] {
		// pi-tui's Text returns an empty array for an empty string (not [""]) — that detail is mirrored here
		return this.text ? [this.text] : [];
	}
}

class FakeContainer {
	children: unknown[] = [];
	addChild(child: unknown): void {
		this.children.push(child);
	}
	render(width: number): string[] {
		return this.children.flatMap((child) => (child as { render(w: number): string[] }).render(width));
	}
}

/** Fill a whole listing into the container in `showLoadedResources`'s order. */
function fillLoadedResources(container: FakeContainer, names: readonly string[] = ["Context", "Skills", "Prompts", "Extensions", "Themes"]): void {
	container.addChild(new FakeSpacer()); // the extra blank row before [Context]
	for (const name of names) {
		container.addChild(new FakeSection(name));
		container.addChild(new FakeSpacer());
	}
}

const titlesIn = (container: FakeContainer): string[] =>
	container.children
		.map((child) => sectionTitleOfLine((child as FakeSection).render(80)[0]))
		.filter((title): title is string => title !== undefined);

test("sectionTitleOfLine: only a whole `[Name]` row counts — ANSI plays no part", () => {
	assert.equal(sectionTitleOfLine("\u001b[36m[Context]\u001b[39m"), "Context");
	assert.equal(sectionTitleOfLine("  [Prompts]  "), "Prompts");
	assert.equal(sectionTitleOfLine("[Skill conflicts]"), "Skill conflicts");
	assert.equal(sectionTitleOfLine("[Context] three files"), undefined);
	assert.equal(sectionTitleOfLine("[[Context]]"), undefined);
	assert.equal(sectionTitleOfLine(""), undefined);
	assert.equal(sectionTitleOfLine(undefined), undefined);
	assert.equal(sectionTitleOfLine(42), undefined);
});

test("isHiddenSection / isBlankLineComponent: only the first row is read; a render throw just counts as \"no\"", () => {
	assert.equal(isHiddenSection(new FakeSection("Context")), true);
	assert.equal(isHiddenSection(new FakeSection("Prompts")), true);
	assert.equal(isHiddenSection(new FakeSection("Themes")), true);
	assert.equal(isHiddenSection(new FakeSection("Skills")), false);
	assert.equal(isHiddenSection(new FakeSection("Extensions")), false);
	assert.equal(isHiddenSection(new FakeSpacer()), false);
	assert.equal(isHiddenSection({ render: () => [{}, "x"] }), false);
	assert.equal(
		isHiddenSection({
			render: () => {
				throw new Error("boom");
			},
		}),
		false,
	);
	assert.equal(isHiddenSection(undefined), false);
	assert.equal(isBlankLineComponent(new FakeSpacer()), true);
	assert.equal(isBlankLineComponent(new FakeText("")), false, "an empty Text renders [], not a spacer shape");
	assert.equal(isBlankLineComponent(new FakeSection("Skills")), false);
	assert.equal(isBlankLineComponent({ render: () => [""] }), true);
});

test("the addChild takeover: the three hidden sections and their separator blanks never enter", () => {
	const container = new FakeContainer();
	assert.equal(installHiddenSectionPruner({ container }) !== undefined, true);
	fillLoadedResources(container);

	assert.deepEqual(titlesIn(container), ["Skills", "Extensions"]);
	// the leading blank + the separator blanks after [Skills] and [Extensions]
	assert.equal(container.children.length, 5);
	assert.deepEqual(container.children.map((child) => child instanceof FakeSpacer), [true, false, true, false, true]);
});

test("the addChild takeover: non-`[x]` shapes, throwing renders, and non-object children all pass through", () => {
	const container = new FakeContainer();
	installHiddenSectionPruner({ container });
	const throwing = {
		render: () => {
			throw new Error("boom");
		},
	};
	const plainText = new FakeText("[Context] these three files");
	container.addChild(throwing);
	container.addChild(plainText);
	container.addChild("a bare string");
	container.addChild(new FakeText(""));
	assert.deepEqual(container.children, [throwing, plainText, "a bare string", container.children[3]]);
});

test("the addChild takeover: only a pruned section eats its following blank — an ordinary section's stays", () => {
	const container = new FakeContainer();
	installHiddenSectionPruner({ container });
	container.addChild(new FakeSection("Skills"));
	container.addChild(new FakeSpacer());
	container.addChild(new FakeSection("Prompts"));
	container.addChild(new FakeSpacer());
	container.addChild(new FakeSection("Extensions"));
	assert.deepEqual(titlesIn(container), ["Skills", "Extensions"]);
	assert.equal(container.children.length, 3);
});

test("pruneHiddenSections: installed late (listing already filled) still prunes cleanly", () => {
	const container = new FakeContainer();
	fillLoadedResources(container);
	assert.equal(container.children.length, 11); // 1 + 5×2
	assert.equal(pruneHiddenSections(container), 3);
	assert.deepEqual(titlesIn(container), ["Skills", "Extensions"]);
	assert.equal(container.children.length, 5);
});

test("pruneHiddenSections: no hidden sections → 0, unchanged", () => {
	const container = new FakeContainer();
	fillLoadedResources(container, ["Skills", "Extensions"]);
	const before = [...container.children];
	assert.equal(pruneHiddenSections(container), 0);
	assert.deepEqual(container.children, before);
	assert.equal(pruneHiddenSections(undefined), 0);
	assert.equal(pruneHiddenSections({}), 0);
});

test("installHiddenSectionPruner: late install first prunes existing content; new additions still never enter", () => {
	const container = new FakeContainer();
	fillLoadedResources(container);
	installHiddenSectionPruner({ container });
	assert.deepEqual(titlesIn(container), ["Skills", "Extensions"]);
	// /reload: after clear(), fill a fresh listing
	container.children = [];
	container.addChild(new FakeSpacer());
	container.addChild(new FakeSection("Context"));
	container.addChild(new FakeSpacer());
	container.addChild(new FakeSection("Skills"));
	assert.deepEqual(titlesIn(container), ["Skills"]);
});

test("the takeover is idempotent: repeat installs stack no wrappers, an old release cannot tear down the new one, release restores the original", () => {
	const container = new FakeContainer();
	const release1 = installHiddenSectionPruner({ container });
	assert.equal(typeof release1, "function");
	const release2 = installHiddenSectionPruner({ container });
	assert.equal(typeof release2, "function");

	// the second install already replaced the first: calling the old release must not tear down the new wrapper
	release1!();
	container.addChild(new FakeSection("Context"));
	assert.deepEqual(titlesIn(container), [], "an old release must not touch the new takeover");

	assert.equal(releaseHiddenSectionPruner(container), true);
	release2!();
	assert.equal(releaseHiddenSectionPruner(container), false);

	// after release, newly added sections are no longer pruned (equivalent to pi-tui Container's original addChild)
	container.addChild(new FakeSection("Context"));
	assert.deepEqual(titlesIn(container), ["Context"]);
});

test("the takeover record hangs on the symbol key: another instance can release the old one", () => {
	const container = new FakeContainer();
	installHiddenSectionPruner({ container });
	assert.equal(typeof (container as { [SECTION_PRUNER_KEY]?: unknown })[SECTION_PRUNER_KEY], "object");
	// simulating /reload: a new instance with only the container must still clear the old wrapper
	assert.equal(releaseHiddenSectionPruner(container), true);
	assert.equal((container as { [SECTION_PRUNER_KEY]?: unknown })[SECTION_PRUNER_KEY], undefined);
	const container2 = new FakeContainer();
	assert.equal(releaseHiddenSectionPruner(container2), false);
});

test("findLoadedResourcesContainer: identified as the header container's next sibling — undefined when unrecognizable", () => {
	const headerContainer = new FakeContainer();
	const loadedResources = new FakeContainer();
	const chatContainer = new FakeContainer();
	const document = new FakeContainer();
	document.addChild(headerContainer);
	document.addChild(loadedResources);
	document.addChild(chatContainer);
	const root = { children: [document] };

	assert.equal(findLoadedResourcesContainer({ root, headerContainer }), loadedResources);
	// the header container not in the tree → cannot be found
	assert.equal(findLoadedResourcesContainer({ root, headerContainer: new FakeContainer() }), undefined);
	assert.equal(findLoadedResourcesContainer({ root, headerContainer: undefined }), undefined);
	// the sibling is not container-shaped → cannot be found
	const oddHeader = new FakeContainer();
	const oddDocument = new FakeContainer();
	oddDocument.addChild(oddHeader);
	oddDocument.addChild({ notAContainer: true });
	assert.equal(findLoadedResourcesContainer({ root: { children: [oddDocument] }, headerContainer: oddHeader }), undefined);
});

test("hideLoadedSections: the whole chain (find the container → take over → fill the listing)", () => {
	const headerContainer = new FakeContainer();
	const loadedResources = new FakeContainer();
	const document = new FakeContainer();
	document.addChild(headerContainer);
	document.addChild(loadedResources);
	const root = { children: [document] };

	assert.equal(hideLoadedSections({ root, headerContainer }), true);
	fillLoadedResources(loadedResources);
	assert.deepEqual(titlesIn(loadedResources), ["Skills", "Extensions"]);

	// finding no container returns false and changes nothing
	assert.equal(hideLoadedSections({ root, headerContainer: new FakeContainer() }), false);
	// a custom hidden-name list
	const other = new FakeContainer();
	const otherHeader = new FakeContainer();
	const otherDocument = new FakeContainer();
	otherDocument.addChild(otherHeader);
	otherDocument.addChild(other);
	assert.equal(hideLoadedSections({ root: { children: [otherDocument] }, headerContainer: otherHeader, names: ["Skills"] }), true);
	fillLoadedResources(other);
	assert.deepEqual(titlesIn(other), ["Context", "Prompts", "Extensions", "Themes"]);
});

test("the default hidden list is Context / Prompts / Themes, and the detection width is a normal value", () => {
	assert.deepEqual(HIDDEN_SECTION_NAMES, ["Context", "Prompts", "Themes"]);
	assert.ok(DETECT_WIDTH >= 80, "the title row `[Context]` is only 9 columns — the detection width just needs to be wide enough");
});
