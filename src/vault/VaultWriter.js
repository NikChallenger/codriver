const LOCAL_TRASH_DIRECTORY = ".trash";
const MAX_TRASH_DISCOVERY_ENTRIES = 10000;

class VaultWriter {
  constructor(vault, fileManager = null, diagnostics = null) {
    this.vault = vault;
    this.fileManager = fileManager;
    this.diagnostics = diagnostics;
  }

  async planNoteCreation(request) {
    const requestedPath = normalizeCreateNotePath(request?.path, this.vault?.configDir);
    if (typeof request?.content !== "string") {
      throw new Error("Set Markdown content before creating a note.");
    }

    if (await this.findCreateNoteVaultPath(requestedPath)) {
      throw new Error(`A vault file or folder already exists at: ${requestedPath}`);
    }

    const pathSegments = requestedPath.split("/");
    let canonicalParentSegments = [];
    const missingParentFolders = [];
    for (const parentSegment of pathSegments.slice(0, -1)) {
      const parentPath = [...canonicalParentSegments, parentSegment].join("/");
      const existingParent = await this.findCreateNoteVaultPath(parentPath);
      if (!existingParent) {
        canonicalParentSegments.push(parentSegment);
        missingParentFolders.push(parentPath);
        continue;
      }

      if (!isVaultFolder(existingParent)) {
        throw new Error(`Cannot create the note because a parent path is not a folder: ${parentPath}`);
      }

      canonicalParentSegments = existingParent.path.split("/");
    }

    const path = [...canonicalParentSegments, pathSegments.at(-1)].join("/");

    return {
      path,
      content: request.content,
      characterCount: request.content.length,
      missingParentFolders
    };
  }

  async createNote(request, authorization) {
    assertNoteCreateAuthorization(authorization);
    const plan = await this.planNoteCreation(request);
    const createdParentFolders = [];
    this.logCreateNoteDiagnostics("note-create.start", plan, authorization);

    try {
      if (typeof this.vault.createFolder !== "function" || typeof this.vault.create !== "function") {
        throw new Error("Note creation requires Obsidian Vault APIs.");
      }

      for (const folderPath of plan.missingParentFolders) {
        const existingFolder = await this.findCreateNoteVaultPath(folderPath);
        if (existingFolder) {
          if (!isVaultFolder(existingFolder)) {
            throw new Error(`Cannot create the note because a parent path is not a folder: ${folderPath}`);
          }
          continue;
        }

        await this.vault.createFolder(folderPath);
        createdParentFolders.push(folderPath);
      }

      if (await this.findCreateNoteVaultPath(plan.path)) {
        throw new Error(`A vault file or folder already exists at: ${plan.path}`);
      }

      const file = await this.vault.create(plan.path, plan.content);
      const result = {
        path: file?.path ?? plan.path,
        created: true,
        parentFoldersCreated: createdParentFolders,
        characterCount: plan.characterCount
      };
      this.logCreateNoteDiagnostics("note-create.success", plan, authorization, result);
      return result;
    } catch (error) {
      this.logCreateNoteDiagnostics("note-create.failed", plan, authorization, {
        parentFoldersCreated: createdParentFolders,
        errorName: error instanceof Error ? error.name : "Error"
      });
      throw error;
    }
  }

  planNoteDeletion(request) {
    const path = validateDeleteNotePath(request?.path, this.vault?.configDir);
    const file = this.vault.getAbstractFileByPath?.(path);
    if (!file) {
      throw new Error(`Delete note target was not found: ${path}`);
    }
    if (file.path !== path) {
      throw new Error(`Delete note requires the exact canonical note path: ${file.path}`);
    }
    if (isVaultFolder(file) || file.extension !== "md") {
      throw new Error("Only existing Markdown notes can be moved to trash through this tool.");
    }

    return {
      path: file.path,
      ctime: normalizeFileStatValue(file.stat?.ctime),
      mtime: normalizeFileStatValue(file.stat?.mtime),
      size: normalizeFileStatValue(file.stat?.size)
    };
  }

  async deleteAuthorizedNote(request) {
    assertNoteDeleteAuthorization(request?.authorization);
    const plan = this.planNoteDeletion(request);
    assertDeleteNoteSnapshot(request?.snapshot, plan);
    if (typeof this.vault.trash !== "function") {
      throw new Error("Deleting notes requires Obsidian's Vault trash API.");
    }

    const file = this.vault.getAbstractFileByPath?.(plan.path);
    const trashSnapshot = await captureLocalTrashSnapshot(this.vault.adapter);
    this.logDeleteNoteDiagnostics("note-delete.start", plan, request.authorization);
    try {
      await this.vault.trash(file, false);
      const recovery = await createDeleteRecoveryReceipt(this.vault.adapter, trashSnapshot, plan);
      const result = {
        path: plan.path,
        trashed: true,
        trashLocation: "vault-local",
        recovery
      };
      this.logDeleteNoteDiagnostics("note-delete.success", plan, request.authorization, result);
      return result;
    } catch (error) {
      this.logDeleteNoteDiagnostics("note-delete.failed", plan, request.authorization, {
        errorName: error instanceof Error ? error.name : "Error"
      });
      throw error;
    }
  }

  async restoreTrashedNote(request) {
    assertNoteRestoreAuthorization(request?.authorization);
    const receipt = validateDeleteRecoveryReceipt(request?.recovery, this.vault?.configDir);
    const adapter = this.vault?.adapter;
    if (
      typeof adapter?.exists !== "function" ||
      typeof adapter?.stat !== "function" ||
      typeof adapter?.rename !== "function"
    ) {
      throw new Error("Restoring a trashed note requires Obsidian Adapter APIs.");
    }

    if (this.findVaultPathCaseInsensitive(receipt.originalPath) || await adapter.exists(receipt.originalPath)) {
      throw new Error(`Restore destination already exists: ${receipt.originalPath}`);
    }

    const parentPath = getParentPath(receipt.originalPath);
    const parent = parentPath
      ? this.vault.getAbstractFileByPath?.(parentPath)
      : this.vault.getRoot?.();
    if (!isVaultFolder(parent)) {
      throw new Error(`Restore destination folder was not found: ${parentPath || "/"}`);
    }

    if (!(await adapter.exists(receipt.trashPath))) {
      throw new Error("The trashed note was not found. It may have been moved or permanently deleted.");
    }

    const currentStat = normalizeAdapterStat(await adapter.stat(receipt.trashPath));
    assertDeleteRecoverySnapshot(receipt, currentStat);
    this.logRestoreNoteDiagnostics("note-restore.start", receipt, request.authorization);
    try {
      await adapter.rename(receipt.trashPath, receipt.originalPath);
      const result = {
        path: receipt.originalPath,
        restored: true,
        restoredAt: Date.now()
      };
      this.logRestoreNoteDiagnostics("note-restore.success", receipt, request.authorization, result);
      return result;
    } catch (error) {
      this.logRestoreNoteDiagnostics("note-restore.failed", receipt, request.authorization, {
        errorName: error instanceof Error ? error.name : "Error"
      });
      throw error;
    }
  }

  async planFileMove(request) {
    const sourcePath = validateMoveFilePath(request?.sourcePath, "source", this.vault?.configDir);
    const requestedDestinationPath = validateMoveFilePath(
      request?.destinationPath,
      "destination",
      this.vault?.configDir
    );
    if (sourcePath.toLowerCase() === requestedDestinationPath.toLowerCase()) {
      throw new Error("Source and destination must be different. Case-only renames are not supported.");
    }

    const sourceFile = this.vault.getAbstractFileByPath?.(sourcePath);
    if (!sourceFile) {
      throw new Error(`Source file was not found: ${sourcePath}`);
    }
    if (sourceFile.path !== sourcePath) {
      throw new Error(`Move file requires the exact canonical source path: ${sourceFile.path}`);
    }
    if (isVaultFolder(sourceFile)) {
      throw new Error("Only files can be moved through this tool. Moving folders is not supported.");
    }

    if (await this.findMoveVaultPath(requestedDestinationPath)) {
      throw new Error(`Destination already exists: ${requestedDestinationPath}`);
    }

    const destinationSegments = requestedDestinationPath.split("/");
    const canonicalParentSegments = [];
    const missingParentFolders = [];
    for (const parentSegment of destinationSegments.slice(0, -1)) {
      const parentPath = [...canonicalParentSegments, parentSegment].join("/");
      const existingParent = await this.findMoveVaultPath(parentPath);
      if (!existingParent) {
        canonicalParentSegments.push(parentSegment);
        missingParentFolders.push(parentPath);
        continue;
      }
      if (!isVaultFolder(existingParent)) {
        throw new Error(`Cannot move the file because a parent path is not a folder: ${parentPath}`);
      }
      canonicalParentSegments.splice(0, canonicalParentSegments.length, ...existingParent.path.split("/"));
    }

    const destinationPath = [...canonicalParentSegments, destinationSegments.at(-1)].join("/");
    if (sourcePath.toLowerCase() === destinationPath.toLowerCase()) {
      throw new Error("Source and destination must be different. Case-only renames are not supported.");
    }
    if (await this.findMoveVaultPath(destinationPath)) {
      throw new Error(`Destination already exists: ${destinationPath}`);
    }

    return {
      sourcePath,
      destinationPath,
      extension: typeof sourceFile.extension === "string" ? sourceFile.extension : "",
      ctime: normalizeFileStatValue(sourceFile.stat?.ctime),
      mtime: normalizeFileStatValue(sourceFile.stat?.mtime),
      size: normalizeFileStatValue(sourceFile.stat?.size),
      missingParentFolders
    };
  }

  async moveAuthorizedFile(request) {
    assertFileMoveAuthorization(request?.authorization);
    if (
      typeof this.fileManager?.renameFile !== "function" ||
      typeof this.vault?.createFolder !== "function"
    ) {
      throw new Error("Moving files requires Obsidian's FileManager and Vault APIs.");
    }

    const plan = await this.planFileMove(request);
    assertFileMoveSnapshot(request?.snapshot, plan);
    const createdParentFolders = [];
    this.logFileMoveDiagnostics("file-move.start", plan, request.authorization);

    try {
      for (const folderPath of plan.missingParentFolders) {
        assertFileMoveAuthorization(request.authorization);
        if (await this.findMoveVaultPath(folderPath)) {
          throw new Error("Destination folder state changed after this move was prepared. Prepare the move again.");
        }
        await this.vault.createFolder(folderPath);
        createdParentFolders.push(folderPath);
      }

      const currentSource = this.vault.getAbstractFileByPath?.(plan.sourcePath);
      const currentSnapshot = createFileMoveSourceSnapshot(currentSource, plan);
      assertFileMoveSourceSnapshot(plan, currentSnapshot);
      if (await this.findMoveVaultPath(plan.destinationPath)) {
        throw new Error(`Destination already exists: ${plan.destinationPath}`);
      }

      assertFileMoveAuthorization(request.authorization);
      await this.fileManager.renameFile(currentSource, plan.destinationPath);
      const result = {
        moved: true,
        sourcePath: plan.sourcePath,
        destinationPath: plan.destinationPath,
        parentFoldersCreated: createdParentFolders
      };
      this.logFileMoveDiagnostics("file-move.success", plan, request.authorization, result);
      return result;
    } catch (error) {
      const cleanup = await this.cleanupCreatedFileMoveFolders(createdParentFolders);
      const destinationExists = Boolean(await this.findMoveVaultPath(plan.destinationPath));
      const sourceExists = Boolean(this.vault.getAbstractFileByPath?.(plan.sourcePath));
      this.logFileMoveDiagnostics("file-move.failed", plan, request.authorization, {
        parentFoldersCreated: createdParentFolders,
        parentFoldersRemoved: cleanup.removed,
        parentFolderCleanupFailures: cleanup.failed,
        destinationExists,
        sourceExists,
        errorName: error instanceof Error ? error.name : "Error"
      });
      if (cleanup.failed.length > 0) {
        throw new Error(
          "The file move failed and CoDriver could not safely remove every empty folder created for it. " +
          "Review the destination path before retrying."
        );
      }
      if (destinationExists && !sourceExists) {
        throw new Error(
          "Obsidian reported a file-move error after the destination appeared. Inspect the reviewed source and destination paths before retrying."
        );
      }
      throw error;
    }
  }

  async cleanupCreatedFileMoveFolders(folderPaths) {
    const removed = [];
    const failed = [];
    for (const folderPath of [...folderPaths].reverse()) {
      const folder = this.vault.getAbstractFileByPath?.(folderPath);
      if (!isVaultFolder(folder) || this.hasVaultDescendant(folderPath)) {
        failed.push(folderPath);
        continue;
      }
      if (typeof this.vault.delete !== "function") {
        failed.push(folderPath);
        continue;
      }
      try {
        await this.vault.delete(folder, true);
        removed.push(folderPath);
      } catch {
        failed.push(folderPath);
      }
    }
    return { removed, failed };
  }

  hasVaultDescendant(folderPath) {
    const prefix = `${folderPath}/`;
    const loadedFiles = typeof this.vault.getAllLoadedFiles === "function"
      ? this.vault.getAllLoadedFiles()
      : [];
    return loadedFiles.some((item) => typeof item?.path === "string" && item.path.startsWith(prefix));
  }

  findVaultPathCaseInsensitive(path) {
    const normalizedPath = path.toLowerCase();
    const exactFile = this.vault.getAbstractFileByPath?.(path);
    if (exactFile) {
      return exactFile;
    }

    const loadedFiles = typeof this.vault.getAllLoadedFiles === "function"
      ? this.vault.getAllLoadedFiles()
      : [];
    return loadedFiles.find((file) => (
      typeof file?.path === "string" && file.path.toLowerCase() === normalizedPath
    )) ?? null;
  }

  async findCreateNoteVaultPath(path) {
    const exactFile = this.vault.getAbstractFileByPath?.(path);
    if (exactFile) {
      return exactFile;
    }

    if (typeof this.vault.adapter?.exists !== "function" || !(await this.vault.adapter.exists(path))) {
      return null;
    }

    return this.findVaultPathCaseInsensitive(path) ?? {
      path,
      unresolvedAdapterEntry: true
    };
  }

  async findMoveVaultPath(path) {
    const loadedPath = this.findVaultPathCaseInsensitive(path);
    if (loadedPath) {
      return loadedPath;
    }
    if (typeof this.vault.adapter?.exists !== "function" || !(await this.vault.adapter.exists(path))) {
      return null;
    }
    return {
      path,
      unresolvedAdapterEntry: true
    };
  }

  async applyApprovedChange(proposal, authorization) {
    assertNotePatchAuthorization(authorization);
    if (proposal.status !== "accepted") {
      throw new Error("Cannot apply a note change before it is accepted for an authorized write.");
    }

    proposal.applicationAuthorizationSource = authorization.source;

    if (proposal.kind === "frontmatter") {
      await this.applyApprovedFrontmatterChange(proposal, authorization);
      return;
    }

    await this.applyApprovedTextChange(proposal, authorization);
  }

  async validatePendingTextChange(proposal) {
    const file = this.getMarkdownFile(proposal.notePath);
    const currentContent = await this.vault.read(file);
    const changes = this.getTextChanges(proposal);
    const messages = {
      missing: "The proposed text was not found in the current note. Read the note again and use exact current text in before.",
      duplicate: "The proposed text appears more than once. Add exact surrounding context before preparing the patch.",
      overlap: "The proposed text changes overlap. Prepare non-overlapping changes."
    };
    this.createTextChangeApplication(currentContent, changes, messages);

    return {
      path: file.path,
      changeCount: changes.length
    };
  }

  async appendAuthorizedContent(operation) {
    assertNoteAppendAuthorization(operation?.authorization);

    const file = this.getAppendMarkdownFile(operation.notePath);
    if (typeof this.vault.process !== "function") {
      throw new Error("Append note requires the Obsidian atomic vault process API.");
    }

    await this.vault.process(file, (currentContent) => (
      currentContent + createAppendContent(currentContent, operation.content)
    ));

    return {
      path: file.path,
      appended: true
    };
  }

  async applyApprovedTextChange(proposal, authorization) {
    const file = this.getMarkdownFile(proposal.notePath);
    const currentContent = await this.vault.read(file);
    const changes = this.getTextChanges(proposal);
    const messages = {
      missing: "The approved text was not found in the current note. The note may have changed.",
      duplicate: "The approved text appears more than once. Make the proposal more specific before applying it.",
      overlap: "The approved text changes overlap. CoDriver cannot apply them safely."
    };
    this.logTextChangeDiagnostics("note-edit.text.apply.start", proposal, currentContent, changes);

    try {
      const application = this.createTextChangeApplication(currentContent, changes, messages);
      const nextContent = application.nextContent;
      assertNotePatchAuthorization(authorization);
      await this.vault.modify(file, nextContent);
      proposal.appliedTextChanges = createAppliedTextChangeSnapshot(currentContent, nextContent, application.ranges);
      this.logTextChangeDiagnostics("note-edit.text.apply.success", proposal, nextContent, changes);
    } catch (error) {
      this.logTextChangeDiagnostics("note-edit.text.apply.failed", proposal, currentContent, changes, error);
      throw error;
    }
  }

  async rollbackApprovedChange(proposal) {
    if (proposal.status !== "accepted") {
      throw new Error("Only an accepted note change can be rolled back.");
    }

    if (proposal.kind === "frontmatter") {
      await this.rollbackApprovedFrontmatterChange(proposal);
      return;
    }

    await this.rollbackApprovedTextChange(proposal);
  }

  async rollbackApprovedTextChange(proposal) {
    const file = this.getMarkdownFile(proposal.notePath);
    const currentContent = await this.vault.read(file);
    const changes = this.getRollbackTextChanges(proposal);
    const messages = {
      missing: "The accepted replacement text was not found in the current note. The note may have changed.",
      duplicate: "The accepted replacement text appears more than once. CoDriver cannot roll it back safely.",
      overlap: "The accepted replacement text changes overlap. CoDriver cannot roll them back safely."
    };
    this.logTextChangeDiagnostics("note-edit.text.rollback.start", proposal, currentContent, changes);

    try {
      const nextContent = this.createSnapshotRollbackContent(currentContent, proposal, messages) ??
        this.applyTextChanges(currentContent, changes, messages);
      await this.vault.modify(file, nextContent);
      this.logTextChangeDiagnostics("note-edit.text.rollback.success", proposal, nextContent, changes);
    } catch (error) {
      this.logTextChangeDiagnostics("note-edit.text.rollback.failed", proposal, currentContent, changes, error);
      throw error;
    }
  }

  async applyApprovedFrontmatterChange(proposal, authorization) {
    const file = this.getMarkdownFile(proposal.notePath);
    await this.processFrontmatter(file, (frontmatter) => {
      this.assertFrontmatterSnapshot(frontmatter, proposal.before, "The approved frontmatter no longer matches the current note.");
      assertNotePatchAuthorization(authorization);
      this.applyFrontmatterSnapshot(frontmatter, proposal.after);
    });
  }

  async rollbackApprovedFrontmatterChange(proposal) {
    const file = this.getMarkdownFile(proposal.notePath);
    await this.processFrontmatter(file, (frontmatter) => {
      this.assertFrontmatterSnapshot(frontmatter, proposal.after, "The accepted frontmatter no longer matches the current note.");
      this.applyFrontmatterSnapshot(frontmatter, proposal.before);
    });
  }

  async processFrontmatter(file, callback) {
    const processor = this.fileManager?.processFrontMatter ?? this.vault.processFrontMatter;
    if (typeof processor !== "function") {
      throw new Error("Frontmatter updates require Obsidian frontmatter APIs.");
    }

    const host = this.fileManager?.processFrontMatter ? this.fileManager : this.vault;
    await processor.call(host, file, callback);
  }

  assertFrontmatterSnapshot(frontmatter, expectedSnapshot, message) {
    if (!isPlainObject(expectedSnapshot)) {
      throw new Error("Approved frontmatter change is missing the expected current metadata.");
    }

    for (const key of Object.keys(expectedSnapshot)) {
      if (!frontmatterValuesEqual(frontmatter[key], expectedSnapshot[key])) {
        throw new Error(message);
      }
    }
  }

  applyFrontmatterSnapshot(frontmatter, nextSnapshot) {
    if (!isPlainObject(nextSnapshot)) {
      throw new Error("Approved frontmatter change is missing replacement metadata.");
    }

    for (const key of Object.keys(nextSnapshot)) {
      const value = nextSnapshot[key];
      if (value === null) {
        delete frontmatter[key];
        continue;
      }

      frontmatter[key] = cloneJsonValue(value);
    }
  }

  getMarkdownFile(notePath) {
    if (typeof notePath !== "string" || notePath.trim().length === 0) {
      throw new Error("Approved note change is missing a target note path.");
    }

    const file = this.vault.getAbstractFileByPath(notePath);
    if (!file) {
      throw new Error(`Target note was not found: ${notePath}`);
    }

    if (file.extension !== "md") {
      throw new Error("Approved note change target is not a Markdown note.");
    }

    return file;
  }

  getAppendMarkdownFile(notePath) {
    if (typeof notePath !== "string" || notePath.trim().length === 0) {
      throw new Error("Append note is missing a target note path.");
    }

    const normalizedPath = notePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (normalizedPath.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new Error("Append note target path must stay inside the current vault.");
    }

    const file = this.vault.getAbstractFileByPath(normalizedPath);
    if (!file) {
      throw new Error(`Append note target was not found: ${normalizedPath}`);
    }

    if (file.extension !== "md") {
      throw new Error("Append note target is not a Markdown note.");
    }

    return file;
  }

  createExactReplacement(currentContent, before, after, messages) {
    if (typeof before !== "string" || before.length === 0) {
      throw new Error("Approved note change is missing exact text to replace.");
    }

    if (typeof after !== "string") {
      throw new Error("Approved note change is missing replacement text.");
    }

    const firstIndex = currentContent.indexOf(before);
    if (firstIndex === -1) {
      throw new Error(messages.missing);
    }

    const secondIndex = currentContent.indexOf(before, firstIndex + before.length);
    if (secondIndex !== -1) {
      throw new Error(messages.duplicate);
    }

    return [
      currentContent.slice(0, firstIndex),
      after,
      currentContent.slice(firstIndex + before.length)
    ].join("");
  }

  getTextChanges(proposal) {
    if (Array.isArray(proposal.changes) && proposal.changes.length > 0) {
      return proposal.changes.map(normalizeTextChange);
    }

    return [normalizeTextChange({
      before: proposal.before,
      after: proposal.after
    })];
  }

  getRollbackTextChanges(proposal) {
    return this.getTextChanges(proposal).map((change) => ({
      before: change.after,
      after: change.before,
      contextBefore: change.contextBefore,
      contextAfter: change.contextAfter
    }));
  }

  applyTextChanges(currentContent, changes, messages) {
    return this.createTextChangeApplication(currentContent, changes, messages).nextContent;
  }

  createTextChangeApplication(currentContent, changes, messages) {
    const ranges = this.findTextChangeRanges(currentContent, changes, messages);
    const sortedRanges = ranges
      .slice()
      .sort((left, right) => left.start - right.start);

    for (let index = 1; index < sortedRanges.length; index += 1) {
      if (sortedRanges[index].start < sortedRanges[index - 1].end) {
        throw new Error(messages.overlap);
      }
    }

    let nextContent = currentContent;
    for (const range of sortedRanges.slice().reverse()) {
      nextContent = [
        nextContent.slice(0, range.start),
        range.after,
        nextContent.slice(range.end)
      ].join("");
    }

    return {
      nextContent,
      ranges: sortedRanges
    };
  }

  findTextChangeRanges(currentContent, changes, messages) {
    try {
      return changes.map((change) => this.findTextChangeRange(currentContent, change, messages));
    } catch (error) {
      const fallbackRanges = this.findIdenticalExactReplacementRanges(currentContent, changes);
      if (fallbackRanges) {
        return fallbackRanges;
      }

      throw error;
    }
  }

  findIdenticalExactReplacementRanges(currentContent, changes) {
    if (!canUseIdenticalExactReplacementFallback(changes)) {
      return null;
    }

    const before = changes[0].before;
    const after = changes[0].after;
    const exactMatches = findTextMatches(currentContent, before);
    if (exactMatches.length !== changes.length) {
      return null;
    }

    return exactMatches.map((start) => ({
      start,
      end: start + before.length,
      after
    }));
  }

  findTextChangeRange(currentContent, change, messages) {
    if (typeof change.before !== "string" || change.before.length === 0) {
      throw new Error("Approved note change is missing exact text to replace.");
    }

    if (typeof change.after !== "string") {
      throw new Error("Approved note change is missing replacement text.");
    }

    const exactMatches = findTextMatches(currentContent, change.before)
      .filter((start) => matchesContext(currentContent, start, change.before, change.contextBefore, change.contextAfter));

    if (exactMatches.length === 1) {
      return {
        start: exactMatches[0],
        end: exactMatches[0] + change.before.length,
        after: change.after
      };
    }

    if (exactMatches.length > 1) {
      throw new Error(messages.duplicate);
    }

    const flexibleMatches = findFlexibleWhitespaceMatches(currentContent, change.before)
      .filter((range) => matchesFlexibleContext(currentContent, range, change.contextBefore, change.contextAfter));

    if (flexibleMatches.length === 1) {
      return {
        start: flexibleMatches[0].start,
        end: flexibleMatches[0].end,
        after: change.after
      };
    }

    if (flexibleMatches.length > 1) {
      throw new Error(messages.duplicate);
    }

    const punctuationMatches = findPunctuationFlexibleMatches(currentContent, change.before)
      .filter((range) => matchesPunctuationFlexibleContext(currentContent, range, change.contextBefore, change.contextAfter));

    if (punctuationMatches.length === 0) {
      throw new Error(messages.missing);
    }

    if (punctuationMatches.length > 1) {
      throw new Error(messages.duplicate);
    }

    return {
      start: punctuationMatches[0].start,
      end: punctuationMatches[0].end,
      after: change.after
    };
  }

  createSnapshotRollbackContent(currentContent, proposal, messages) {
    const snapshot = normalizeAppliedTextChangeSnapshot(proposal?.appliedTextChanges);
    if (!snapshot || snapshot.noteHashAfter !== hashText(currentContent)) {
      return null;
    }

    const ranges = snapshot.changes.map((change) => this.findAppliedSnapshotRange(currentContent, change, messages));
    const sortedRanges = ranges
      .slice()
      .sort((left, right) => left.start - right.start);

    for (let index = 1; index < sortedRanges.length; index += 1) {
      if (sortedRanges[index].start < sortedRanges[index - 1].end) {
        throw new Error(messages.overlap);
      }
    }

    let nextContent = currentContent;
    for (const range of sortedRanges.slice().reverse()) {
      nextContent = [
        nextContent.slice(0, range.start),
        range.before,
        nextContent.slice(range.end)
      ].join("");
    }

    return nextContent;
  }

  findAppliedSnapshotRange(currentContent, change, messages) {
    if (typeof change.before !== "string" || typeof change.after !== "string") {
      throw new Error("Approved note change is missing replacement text.");
    }

    if (Number.isInteger(change.appliedStart) && Number.isInteger(change.appliedEnd)) {
      const currentSlice = currentContent.slice(change.appliedStart, change.appliedEnd);
      if (currentSlice === change.after) {
        return {
          start: change.appliedStart,
          end: change.appliedEnd,
          before: change.before
        };
      }
    }

    if (change.after.length > 0) {
      const textMatches = findTextMatches(currentContent, change.after);
      if (textMatches.length === 1) {
        return {
          start: textMatches[0],
          end: textMatches[0] + change.after.length,
          before: change.before
        };
      }

      if (textMatches.length > 1) {
        throw new Error(messages.duplicate);
      }

      throw new Error(messages.missing);
    }

    throw new Error(messages.missing);
  }

  logTextChangeDiagnostics(event, proposal, currentContent, changes, error = null) {
    if (!this.isDiagnosticsEnabled()) {
      return;
    }

    const detail = {
      event,
      notePath: typeof proposal?.notePath === "string" ? proposal.notePath : "",
      proposalId: typeof proposal?.id === "string" ? proposal.id : "",
      proposalKind: proposal?.kind ?? "text",
      proposalStatus: proposal?.status ?? "",
      authorizationSource: proposal?.applicationAuthorizationSource ?? "",
      noteLength: currentContent.length,
      noteHash: hashText(currentContent),
      lineEndings: countLineEndings(currentContent),
      changeCount: changes.length,
      changes: changes.map((change, index) => createTextChangeDiagnostic(index, currentContent, change))
    };

    if (error) {
      detail.error = error instanceof Error ? error.message : String(error);
    }

    this.debug(event, detail);
  }

  logCreateNoteDiagnostics(event, plan, authorization, outcome = {}) {
    if (!this.isDiagnosticsEnabled()) {
      return;
    }

    this.debug(event, {
      notePath: plan.path,
      characterCount: plan.characterCount,
      missingParentFolderCount: plan.missingParentFolders.length,
      authorizationSource: authorization.source,
      parentFoldersCreated: Array.isArray(outcome.parentFoldersCreated)
        ? outcome.parentFoldersCreated.length
        : 0,
      created: outcome.created === true,
      ...(outcome.errorName ? { errorName: outcome.errorName } : {})
    });
  }

  logDeleteNoteDiagnostics(event, plan, authorization, outcome = {}) {
    if (!this.isDiagnosticsEnabled()) {
      return;
    }

    this.debug(event, {
      notePath: plan.path,
      ctime: plan.ctime,
      mtime: plan.mtime,
      size: plan.size,
      authorizationSource: authorization.source,
      trashed: outcome.trashed === true,
      trashLocation: outcome.trashLocation ?? "",
      ...(outcome.errorName ? { errorName: outcome.errorName } : {})
    });
  }

  logFileMoveDiagnostics(event, plan, authorization, outcome = {}) {
    if (!this.isDiagnosticsEnabled()) {
      return;
    }

    this.debug(event, {
      sourcePath: plan.sourcePath,
      destinationPath: plan.destinationPath,
      extension: plan.extension,
      ctime: plan.ctime,
      mtime: plan.mtime,
      size: plan.size,
      missingParentFolderCount: plan.missingParentFolders.length,
      authorizationSource: authorization.source,
      moved: outcome.moved === true,
      parentFoldersCreated: Array.isArray(outcome.parentFoldersCreated)
        ? outcome.parentFoldersCreated.length
        : 0,
      parentFoldersRemoved: Array.isArray(outcome.parentFoldersRemoved)
        ? outcome.parentFoldersRemoved.length
        : 0,
      parentFolderCleanupFailureCount: Array.isArray(outcome.parentFolderCleanupFailures)
        ? outcome.parentFolderCleanupFailures.length
        : 0,
      destinationExists: outcome.destinationExists === true,
      sourceExists: outcome.sourceExists === true,
      ...(outcome.errorName ? { errorName: outcome.errorName } : {})
    });
  }

  logRestoreNoteDiagnostics(event, receipt, authorization, outcome = {}) {
    if (!this.isDiagnosticsEnabled()) {
      return;
    }

    this.debug(event, {
      notePath: receipt.originalPath,
      trashPath: receipt.trashPath,
      ctime: receipt.ctime,
      mtime: receipt.mtime,
      size: receipt.size,
      authorizationSource: authorization.source,
      restored: outcome.restored === true,
      ...(outcome.errorName ? { errorName: outcome.errorName } : {})
    });
  }

  isDiagnosticsEnabled() {
    if (!this.diagnostics) {
      return false;
    }

    if (typeof this.diagnostics.isEnabled === "function") {
      return Boolean(this.diagnostics.isEnabled());
    }

    return Boolean(this.diagnostics.enabled);
  }

  debug(event, detail) {
    if (this.diagnostics && typeof this.diagnostics.debug === "function") {
      this.diagnostics.debug(event, detail);
      return;
    }

    console.info("[CoDriver diagnostics]", event, detail);
  }
}

function createAppendContent(currentContent, content) {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Set non-empty Markdown content before appending to a note.");
  }

  const lineEnding = detectPreferredLineEnding(currentContent);
  const normalizedContent = content.replace(/\r\n|\r|\n/g, lineEnding);
  const needsSeparator = currentContent.length > 0 &&
    !/[\r\n]$/.test(currentContent) &&
    !/^[\r\n]/.test(normalizedContent);

  return `${needsSeparator ? lineEnding : ""}${normalizedContent}`;
}

function detectPreferredLineEnding(content) {
  const counts = {
    "\r\n": (content.match(/\r\n/g) ?? []).length,
    "\n": (content.match(/(?<!\r)\n/g) ?? []).length,
    "\r": (content.match(/\r(?!\n)/g) ?? []).length
  };
  const firstLineEnding = content.match(/\r\n|\r|\n/)?.[0] ?? "\n";

  return Object.entries(counts).reduce((preferred, [lineEnding, count]) => {
    if (count > counts[preferred]) {
      return lineEnding;
    }
    return preferred;
  }, firstLineEnding);
}

function createTextChangeDiagnostic(index, currentContent, change) {
  const exactMatches = findTextMatches(currentContent, change.before);
  const flexibleMatches = findFlexibleWhitespaceMatches(currentContent, change.before);
  const punctuationMatches = findPunctuationFlexibleMatches(currentContent, change.before);
  const contextMatches = exactMatches.filter((start) => (
    matchesContext(currentContent, start, change.before, change.contextBefore, change.contextAfter)
  ));
  const flexibleContextMatches = flexibleMatches.filter((range) => (
    matchesFlexibleContext(currentContent, range, change.contextBefore, change.contextAfter)
  ));
  const punctuationContextMatches = punctuationMatches.filter((range) => (
    matchesPunctuationFlexibleContext(currentContent, range, change.contextBefore, change.contextAfter)
  ));
  const normalizedContent = normalizeDiagnosticText(currentContent);
  const normalizedBefore = normalizeDiagnosticText(change.before);

  return {
    index,
    matchStatus: getTextChangeMatchStatus(contextMatches, flexibleContextMatches, punctuationContextMatches),
    beforeLength: change.before.length,
    beforeHash: hashText(change.before),
    afterLength: change.after.length,
    afterHash: hashText(change.after),
    contextBeforeLength: change.contextBefore.length,
    contextBeforeHash: hashText(change.contextBefore),
    contextAfterLength: change.contextAfter.length,
    contextAfterHash: hashText(change.contextAfter),
    exactMatches: exactMatches.length,
    contextMatches: contextMatches.length,
    flexibleWhitespaceMatches: flexibleMatches.length,
    flexibleWhitespaceContextMatches: flexibleContextMatches.length,
    punctuationFlexibleMatches: punctuationMatches.length,
    punctuationFlexibleContextMatches: punctuationContextMatches.length,
    firstExactMatchIndex: exactMatches[0] ?? -1,
    firstFlexibleMatchIndex: flexibleMatches[0]?.start ?? -1,
    firstPunctuationFlexibleMatchIndex: punctuationMatches[0]?.start ?? -1,
    normalizedWhitespaceMatches: normalizedBefore
      ? findTextMatches(normalizedContent, normalizedBefore).length
      : 0
  };
}

function getTextChangeMatchStatus(exactMatches, flexibleMatches, punctuationMatches) {
  if (exactMatches.length === 1) {
    return "exact";
  }

  if (exactMatches.length > 1) {
    return "ambiguous-exact";
  }

  if (flexibleMatches.length === 1) {
    return "whitespace-flexible";
  }

  if (flexibleMatches.length > 1) {
    return "ambiguous-whitespace-flexible";
  }

  if (punctuationMatches.length === 1) {
    return "punctuation-flexible";
  }

  if (punctuationMatches.length > 1) {
    return "ambiguous-punctuation-flexible";
  }

  return "missing";
}

function countLineEndings(value) {
  const text = String(value ?? "");
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const withoutCrlf = text.replace(/\r\n/g, "");
  const loneCr = (withoutCrlf.match(/\r/g) ?? []).length;
  const loneLf = (withoutCrlf.match(/\n/g) ?? []).length;
  return {
    crlf,
    loneLf,
    loneCr
  };
}

function normalizeDiagnosticText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function hashText(value) {
  const text = String(value ?? "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeTextChange(change) {
  return {
    before: typeof change.before === "string" ? change.before : "",
    after: typeof change.after === "string" ? change.after : "",
    contextBefore: typeof change.contextBefore === "string" ? change.contextBefore : "",
    contextAfter: typeof change.contextAfter === "string" ? change.contextAfter : ""
  };
}

function createAppliedTextChangeSnapshot(beforeContent, afterContent, ranges) {
  let offset = 0;
  const changes = ranges.map((range) => {
    const appliedStart = range.start + offset;
    const appliedEnd = appliedStart + range.after.length;
    offset += range.after.length - (range.end - range.start);

      return {
        before: beforeContent.slice(range.start, range.end),
        after: range.after,
        appliedStart,
        appliedEnd
      };
    });

  return {
    version: 1,
    noteHashBefore: hashText(beforeContent),
    noteHashAfter: hashText(afterContent),
    changes
  };
}

function normalizeAppliedTextChangeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.changes)) {
    return null;
  }

  const noteHashAfter = typeof snapshot.noteHashAfter === "string" ? snapshot.noteHashAfter : "";
  if (!noteHashAfter) {
    return null;
  }

  const changes = snapshot.changes
    .map((change) => {
      if (!change || typeof change !== "object") {
        return null;
      }

      if (typeof change.before !== "string" || typeof change.after !== "string") {
        return null;
      }

      return {
        before: change.before,
        after: change.after,
        appliedStart: Number.isInteger(change.appliedStart) ? change.appliedStart : -1,
        appliedEnd: Number.isInteger(change.appliedEnd) ? change.appliedEnd : -1
      };
    })
    .filter(Boolean);

  if (changes.length === 0) {
    return null;
  }

  return {
    noteHashAfter,
    changes
  };
}

function canUseIdenticalExactReplacementFallback(changes) {
  if (!Array.isArray(changes) || changes.length < 2) {
    return false;
  }

  const first = changes[0];
  if (typeof first.before !== "string" || first.before.length === 0 || typeof first.after !== "string") {
    return false;
  }

  return changes.every((change) => (
    change &&
    change.before === first.before &&
    change.after === first.after
  ));
}

function findTextMatches(content, searchText) {
  const matches = [];
  let startIndex = 0;

  while (startIndex <= content.length) {
    const matchIndex = content.indexOf(searchText, startIndex);
    if (matchIndex === -1) {
      break;
    }

    matches.push(matchIndex);
    startIndex = matchIndex + Math.max(searchText.length, 1);
  }

  return matches;
}

function matchesContext(content, start, before, contextBefore, contextAfter) {
  if (contextBefore) {
    if (start < contextBefore.length) {
      return false;
    }

    if (content.slice(start - contextBefore.length, start) !== contextBefore) {
      return false;
    }
  }

  const end = start + before.length;
  if (contextAfter && content.slice(end, end + contextAfter.length) !== contextAfter) {
    return false;
  }

  return true;
}

function findFlexibleWhitespaceMatches(content, searchText) {
  return findFlexibleTextMatches(content, searchText, { punctuation: false });
}

function findPunctuationFlexibleMatches(content, searchText) {
  return findFlexibleTextMatches(content, searchText, { punctuation: true });
}

function findFlexibleTextMatches(content, searchText, options) {
  if (typeof searchText !== "string" || searchText.length === 0) {
    return [];
  }

  const matches = [];
  for (let start = 0; start < content.length; start += 1) {
    const end = matchFlexibleTextAt(content, searchText, start, options);
    if (end !== -1) {
      matches.push({ start, end });
      start = Math.max(start, end - 1);
    }
  }

  return matches;
}

function matchFlexibleTextAt(content, searchText, start, options) {
  let contentIndex = start;
  let searchIndex = 0;

  while (searchIndex < searchText.length) {
    if (isFlexibleWhitespace(searchText[searchIndex])) {
      if (!isFlexibleWhitespace(content[contentIndex])) {
        return -1;
      }

      while (searchIndex < searchText.length && isFlexibleWhitespace(searchText[searchIndex])) {
        searchIndex += 1;
      }

      while (contentIndex < content.length && isFlexibleWhitespace(content[contentIndex])) {
        contentIndex += 1;
      }

      continue;
    }

    if (!charactersEqual(content[contentIndex], searchText[searchIndex], options)) {
      return -1;
    }

    contentIndex += 1;
    searchIndex += 1;
  }

  return contentIndex;
}

function charactersEqual(contentCharacter, searchCharacter, options) {
  if (contentCharacter === searchCharacter) {
    return true;
  }

  if (!options?.punctuation) {
    return false;
  }

  return normalizeFlexiblePunctuation(contentCharacter) === normalizeFlexiblePunctuation(searchCharacter);
}

function matchesFlexibleContext(content, range, contextBefore, contextAfter) {
  if (!contextBefore && !contextAfter) {
    return true;
  }

  const combined = [
    contextBefore,
    content.slice(range.start, range.end),
    contextAfter
  ].join("");
  const contextStart = findFlexibleWhitespaceMatches(content, combined)
    .filter((candidate) => candidate.start <= range.start && candidate.end >= range.end);

  return contextStart.length > 0;
}

function matchesPunctuationFlexibleContext(content, range, contextBefore, contextAfter) {
  if (!contextBefore && !contextAfter) {
    return true;
  }

  const combined = [
    contextBefore,
    content.slice(range.start, range.end),
    contextAfter
  ].join("");
  const contextStart = findPunctuationFlexibleMatches(content, combined)
    .filter((candidate) => candidate.start <= range.start && candidate.end >= range.end);

  return contextStart.length > 0;
}

function isFlexibleWhitespace(value) {
  return typeof value === "string" && value.length > 0 && /\s/u.test(value);
}

function normalizeFlexiblePunctuation(value) {
  if (typeof value !== "string" || value.length === 0) {
    return value;
  }

  const codePoint = value.charCodeAt(0);
  if ([
    0x0027,
    0x0060,
    0x00b4,
    0x02b9,
    0x02bc,
    0x2018,
    0x2019,
    0x201a,
    0x201b,
    0xff07
  ].includes(codePoint)) {
    return "'";
  }

  if ([
    0x0022,
    0x00ab,
    0x00bb,
    0x201c,
    0x201d,
    0x201e,
    0x201f,
    0x301d,
    0x301e,
    0xff02
  ].includes(codePoint)) {
    return "\"";
  }

  if ([
    0x002d,
    0x2010,
    0x2011,
    0x2012,
    0x2013,
    0x2014,
    0x2015,
    0x2212,
    0xfe58,
    0xfe63,
    0xff0d
  ].includes(codePoint)) {
    return "-";
  }

  return value;
}

function frontmatterValuesEqual(actual, expected) {
  if ((actual === undefined || actual === null) && expected === null) {
    return true;
  }

  return stableJsonStringify(actual) === stableJsonStringify(expected);
}

function stableJsonStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }

  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`
    )).join(",")}}`;
  }

  return JSON.stringify(value);
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertNoteCreateAuthorization(authorization) {
  const allowedSources = new Set(["per-call-approval", "automatic-tool-permission"]);
  if (authorization?.status !== "authorized" || !allowedSources.has(authorization?.source)) {
    throw new Error("Note creation requires authorized user approval or automatic permission.");
  }
}

function assertFileMoveAuthorization(authorization) {
  const allowedSources = new Set(["per-call-approval", "automatic-tool-permission"]);
  if (authorization?.status !== "authorized" || !allowedSources.has(authorization?.source)) {
    throw new Error("Moving a file requires authorized user approval or automatic permission.");
  }
  if (
    authorization.source === "automatic-tool-permission" &&
    (typeof authorization.isCurrent !== "function" || authorization.isCurrent() !== true)
  ) {
    throw new Error("Automatic Move vault file permission is no longer enabled. Review the move manually.");
  }
}

function assertNoteDeleteAuthorization(authorization) {
  const allowedSources = new Set(["per-call-approval", "automatic-tool-permission"]);
  if (authorization?.status !== "authorized" || !allowedSources.has(authorization?.source)) {
    throw new Error("Deleting a note requires authorized user approval or automatic permission.");
  }
}

function assertNoteRestoreAuthorization(authorization) {
  if (authorization?.status !== "authorized" || authorization?.source !== "restore-button") {
    throw new Error("Restoring a note requires an explicit user restore action.");
  }
}

function assertNoteAppendAuthorization(authorization) {
  const allowedSources = new Set(["per-call-approval", "automatic-tool-permission"]);
  if (authorization?.status !== "authorized" || !allowedSources.has(authorization?.source)) {
    throw new Error("Appending to a note requires authorized user approval or automatic permission.");
  }
}

function assertNotePatchAuthorization(authorization) {
  const allowedSources = new Set(["per-call-approval", "automatic-tool-permission"]);
  if (authorization?.status !== "authorized" || !allowedSources.has(authorization?.source)) {
    throw new Error("Applying a note patch requires authorized user approval or automatic permission.");
  }
  if (
    authorization.source === "automatic-tool-permission" &&
    (typeof authorization.isCurrent !== "function" || authorization.isCurrent() !== true)
  ) {
    throw new Error("Automatic Patch note permission is no longer enabled. Review and accept the proposal manually.");
  }
}

function normalizeCreateNotePath(value, configDir = ".obsidian") {
  if (typeof value !== "string") {
    throw new Error("Set a vault-relative Markdown note path before creating a note.");
  }

  const trimmed = value.trim();
  if (!trimmed || /^[\\/]/.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new Error("Set a vault-relative Markdown note path before creating a note.");
  }

  const normalized = trimmed.replaceAll("\\", "/");
  if (normalized.length > 1024 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("The note path contains unsafe characters or is too long.");
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("The note path contains an unsafe path segment.");
  }

  const normalizedConfigDir = String(configDir || ".obsidian")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  const normalizedLower = normalized.toLowerCase();
  if (normalizedConfigDir && (
    normalizedLower === normalizedConfigDir ||
    normalizedLower.startsWith(`${normalizedConfigDir}/`)
  )) {
    throw new Error("CoDriver cannot create notes inside the Obsidian configuration directory.");
  }

  const fileName = segments.at(-1);
  if (!fileName || fileName.toLowerCase() === ".md") {
    throw new Error("Set a valid file name before creating a note.");
  }
  if (!fileName.toLowerCase().endsWith(".md")) {
    throw new Error("Only Markdown notes can be created through this tool.");
  }

  return normalized;
}

function validateMoveFilePath(value, kind, configDir = ".obsidian") {
  const label = kind === "source" ? "Source" : "Destination";
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} file path is required.`);
  }

  const path = value.trim();
  if (
    path !== value ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:/.test(path) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) ||
    path.includes("\\") ||
    path.endsWith("/") ||
    path.includes("//") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.length > 1024
  ) {
    throw new Error(`${label} path must be a normalized vault-relative path using forward slashes.`);
  }

  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} path must not contain empty, current-directory, or parent-directory segments.`);
  }
  const normalizedConfigDir = String(configDir || ".obsidian")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  const lowerPath = path.toLowerCase();
  if (normalizedConfigDir && (
    lowerPath === normalizedConfigDir ||
    lowerPath.startsWith(`${normalizedConfigDir}/`)
  )) {
    throw new Error("CoDriver cannot move files into or out of the Obsidian configuration directory.");
  }

  return path;
}

function createFileMoveSourceSnapshot(file, plan) {
  if (!file || isVaultFolder(file) || file.path !== plan.sourcePath) {
    return null;
  }
  return {
    sourcePath: file.path,
    extension: typeof file.extension === "string" ? file.extension : "",
    ctime: normalizeFileStatValue(file.stat?.ctime),
    mtime: normalizeFileStatValue(file.stat?.mtime),
    size: normalizeFileStatValue(file.stat?.size)
  };
}

function assertFileMoveSourceSnapshot(expected, current) {
  if (
    !current ||
    expected.sourcePath !== current.sourcePath ||
    expected.extension !== current.extension ||
    expected.ctime !== current.ctime ||
    expected.mtime !== current.mtime ||
    expected.size !== current.size
  ) {
    throw new Error("The source file changed after this move was prepared. Prepare the move again.");
  }
}

function assertFileMoveSnapshot(expected, current) {
  if (!expected || typeof expected !== "object") {
    throw new Error("Move file requires a current source and destination snapshot. Prepare the move again.");
  }
  assertFileMoveSourceSnapshot(expected, current);
  if (
    expected.destinationPath !== current.destinationPath ||
    !Array.isArray(expected.missingParentFolders) ||
    expected.missingParentFolders.length !== current.missingParentFolders.length ||
    expected.missingParentFolders.some((path, index) => path !== current.missingParentFolders[index])
  ) {
    throw new Error("The destination state changed after this move was prepared. Prepare the move again.");
  }
}

function validateDeleteNotePath(value, configDir = ".obsidian") {
  if (typeof value !== "string" || !value) {
    throw new Error("Delete note path is required.");
  }
  if (
    value !== value.trim() ||
    value.length > 1024 ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
    value.includes("\\") ||
    value.endsWith("/") ||
    value.includes("//") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Delete note path must be a normalized vault-relative path using forward slashes.");
  }

  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Delete note path must not contain empty, current-directory, or parent-directory segments.");
  }
  const fileName = segments.at(-1);
  if (!fileName || fileName.toLowerCase() === ".md" || !fileName.toLowerCase().endsWith(".md")) {
    throw new Error("Delete note path must identify a Markdown note ending in .md.");
  }

  const normalizedConfigDir = String(configDir || ".obsidian")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  const lowerPath = value.toLowerCase();
  if (normalizedConfigDir && (
    lowerPath === normalizedConfigDir ||
    lowerPath.startsWith(`${normalizedConfigDir}/`)
  )) {
    throw new Error("CoDriver cannot delete notes inside the Obsidian configuration directory.");
  }

  return value;
}

function normalizeFileStatValue(value) {
  return Number.isFinite(value) ? value : null;
}

function assertDeleteNoteSnapshot(expected, current) {
  if (!expected || typeof expected !== "object") {
    throw new Error("Delete note requires a current target snapshot. Prepare the delete request again.");
  }
  if (
    expected.path !== current.path ||
    expected.ctime !== current.ctime ||
    expected.mtime !== current.mtime ||
    expected.size !== current.size
  ) {
    throw new Error("The note changed after this delete request was prepared. Prepare the delete request again.");
  }
}

async function captureLocalTrashSnapshot(adapter) {
  if (typeof adapter?.exists !== "function" || typeof adapter?.list !== "function") {
    return null;
  }

  try {
    if (!(await adapter.exists(LOCAL_TRASH_DIRECTORY))) {
      return new Set();
    }
    return await listLocalTrashFiles(adapter);
  } catch {
    return null;
  }
}

async function createDeleteRecoveryReceipt(adapter, beforePaths, plan) {
  const unavailable = {
    originalPath: plan.path,
    trashPath: "",
    deletedAt: Date.now(),
    ctime: plan.ctime,
    mtime: plan.mtime,
    size: plan.size,
    status: "unavailable",
    error: "CoDriver could not identify the exact local trash item. Restore it manually from the vault trash."
  };
  if (!(beforePaths instanceof Set) || typeof adapter?.list !== "function" || typeof adapter?.stat !== "function") {
    return unavailable;
  }

  try {
    const afterPaths = await listLocalTrashFiles(adapter);
    const newPaths = [...afterPaths].filter((path) => !beforePaths.has(path));
    const trashPath = await selectDeleteRecoveryTrashPath(adapter, newPaths, plan);
    if (!trashPath) {
      return unavailable;
    }

    const stat = normalizeAdapterStat(await adapter.stat(trashPath));
    if (!Number.isFinite(stat.mtime) || !Number.isFinite(stat.size)) {
      return unavailable;
    }
    return {
      originalPath: plan.path,
      trashPath,
      deletedAt: Date.now(),
      ctime: stat.ctime,
      mtime: stat.mtime,
      size: stat.size,
      status: "available",
      error: ""
    };
  } catch {
    return unavailable;
  }
}

async function listLocalTrashFiles(adapter) {
  const files = new Set();
  const pendingFolders = [LOCAL_TRASH_DIRECTORY];
  const visitedFolders = new Set();
  let entryCount = 0;

  while (pendingFolders.length > 0) {
    const folder = pendingFolders.shift();
    if (!folder || visitedFolders.has(folder)) {
      continue;
    }
    visitedFolders.add(folder);
    const listing = await adapter.list(folder);
    for (const path of Array.isArray(listing?.files) ? listing.files : []) {
      const normalizedPath = normalizeAdapterPath(path);
      if (normalizedPath && isPathInsideLocalTrash(normalizedPath)) {
        files.add(normalizedPath);
        entryCount += 1;
      }
    }
    for (const path of Array.isArray(listing?.folders) ? listing.folders : []) {
      const normalizedPath = normalizeAdapterPath(path);
      if (normalizedPath && isPathInsideLocalTrash(normalizedPath)) {
        pendingFolders.push(normalizedPath);
        entryCount += 1;
      }
    }
    if (entryCount > MAX_TRASH_DISCOVERY_ENTRIES) {
      throw new Error("Local trash contains too many entries for automatic recovery discovery.");
    }
  }

  return files;
}

async function selectDeleteRecoveryTrashPath(adapter, newPaths, plan) {
  const expectedSuffix = `/${plan.path}`;
  const exactPathCandidates = newPaths.filter((path) => path.endsWith(expectedSuffix));
  if (exactPathCandidates.length === 1) {
    return exactPathCandidates[0];
  }

  const statMatches = [];
  for (const path of newPaths) {
    const stat = normalizeAdapterStat(await adapter.stat(path));
    if (deleteRecoveryStatsMatch(plan, stat)) {
      statMatches.push(path);
    }
  }
  return statMatches.length === 1 ? statMatches[0] : "";
}

function validateDeleteRecoveryReceipt(value, configDir) {
  if (!value || typeof value !== "object" || value.status !== "available") {
    throw new Error("This delete card does not contain an available recovery receipt.");
  }
  const originalPath = validateDeleteNotePath(value.originalPath, configDir);
  const trashPath = normalizeAdapterPath(value.trashPath);
  if (
    trashPath !== value.trashPath ||
    !isPathInsideLocalTrash(trashPath) ||
    !trashPath.toLowerCase().endsWith(".md") ||
    !Number.isFinite(value.mtime) ||
    !Number.isFinite(value.size)
  ) {
    throw new Error("The recovery receipt contains an invalid local trash path.");
  }

  return {
    originalPath,
    trashPath,
    deletedAt: Number.isFinite(value.deletedAt) ? value.deletedAt : null,
    ctime: normalizeFileStatValue(value.ctime),
    mtime: normalizeFileStatValue(value.mtime),
    size: normalizeFileStatValue(value.size),
    status: "available"
  };
}

function normalizeAdapterPath(value) {
  if (typeof value !== "string" || value !== value.trim() || value.includes("\\")) {
    return "";
  }
  const path = value.replace(/^\/+|\/+$/g, "");
  if (
    !path ||
    path.length > 2048 ||
    path.includes("//") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return "";
  }
  return path;
}

function isPathInsideLocalTrash(path) {
  return path.startsWith(`${LOCAL_TRASH_DIRECTORY}/`);
}

function normalizeAdapterStat(stat) {
  return {
    ctime: normalizeFileStatValue(stat?.ctime),
    mtime: normalizeFileStatValue(stat?.mtime),
    size: normalizeFileStatValue(stat?.size)
  };
}

function deleteRecoveryStatsMatch(expected, current) {
  const comparableKeys = ["ctime", "mtime", "size"].filter((key) => Number.isFinite(expected?.[key]));
  return comparableKeys.length > 0 && comparableKeys.every((key) => expected[key] === current[key]);
}

function assertDeleteRecoverySnapshot(expected, current) {
  if (
    expected.ctime !== current.ctime ||
    expected.mtime !== current.mtime ||
    expected.size !== current.size
  ) {
    throw new Error("The trashed note changed after deletion. Restore it manually after reviewing the current file.");
  }
}

function getParentPath(path) {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? "" : path.slice(0, lastSlash);
}

function isVaultFolder(item) {
  return Array.isArray(item?.children);
}

module.exports = {
  VaultWriter,
  normalizeCreateNotePath
};
