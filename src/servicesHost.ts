import * as typescript from 'typescript';
import * as path from 'path';
import * as semver from 'semver';

import * as constants from './constants';
import * as logger from './logger';
import { makeResolver } from './resolver';
import { appendSuffixesIfMatch, readFile, unorderedRemoveItem } from './utils';
import {
    WatchHost,
    ModuleResolutionHost,
    ResolvedModule,
    ResolveSync,
    TSInstance,
    Webpack
} from './interfaces';

/**
 * Create the TypeScript language service
 */
export function makeServicesHost(
    scriptRegex: RegExp,
    log: logger.Logger,
    loader: Webpack,
    instance: TSInstance,
    appendTsSuffixTo: RegExp[],
    appendTsxSuffixTo: RegExp[]
) {
    const { compiler, compilerOptions, files } = instance;

    const newLine =
        compilerOptions.newLine === constants.CarriageReturnLineFeedCode ? constants.CarriageReturnLineFeed :
            compilerOptions.newLine === constants.LineFeedCode ? constants.LineFeed :
                constants.EOL;

    // make a (sync) resolver that follows webpack's rules
    const resolveSync = makeResolver(loader.options);

    const readFileWithFallback = compiler.sys === undefined || compiler.sys.readFile === undefined
        ? readFile
        : (path: string, encoding?: string | undefined): string | undefined => compiler.sys.readFile(path, encoding) || readFile(path, encoding);

    const fileExists = compiler.sys === undefined || compiler.sys.fileExists === undefined
        ? (path: string) => readFile(path) !== undefined
        : (path: string) => compiler.sys.fileExists(path) || readFile(path) !== undefined;

    const moduleResolutionHost: ModuleResolutionHost = {
        fileExists,
        readFile: readFileWithFallback
    };

    // loader.context seems to work fine on Linux / Mac regardless causes problems for @types resolution on Windows for TypeScript < 2.3
    const getCurrentDirectory = (compiler!.version && semver.gte(compiler!.version, '2.3.0'))
        ? () => loader.context
        : () => process.cwd();

    const resolutionStrategy = (compiler!.version && semver.gte(compiler!.version, '2.4.0'))
        ? resolutionStrategyTS24AndAbove
        : resolutionStrategyTS23AndBelow;

    const servicesHost: typescript.LanguageServiceHost = {
        getProjectVersion: () => `${instance.version}`,

        getScriptFileNames: () => Object.keys(files).filter(filePath => filePath.match(scriptRegex)),

        getScriptVersion: (fileName: string) => {
            fileName = path.normalize(fileName);
            const file = files[fileName];
            return file === undefined ? '' : file.version.toString();
        },

        getScriptSnapshot: (fileName: string) => {
            // This is called any time TypeScript needs a file's text
            // We either load from memory or from disk
            fileName = path.normalize(fileName);
            let file = files[fileName];

            if (file === undefined) {
                const text = readFile(fileName);
                if (text === undefined) { return undefined; }

                file = files[fileName] = { version: 0, text };
            }

            return compiler.ScriptSnapshot.fromString(file.text);
        },
        /**
         * getDirectories is also required for full import and type reference completions.
         * Without it defined, certain completions will not be provided
         */
        getDirectories: compiler.sys ? compiler.sys.getDirectories : undefined,

        /**
         * For @types expansion, these two functions are needed.
         */
        directoryExists: compiler.sys ? compiler.sys.directoryExists : undefined,

        useCaseSensitiveFileNames: compiler.sys
            ? () => compiler.sys.useCaseSensitiveFileNames
            : undefined,

        // The following three methods are necessary for @types resolution from TS 2.4.1 onwards see: https://github.com/Microsoft/TypeScript/issues/16772
        fileExists: compiler.sys ? compiler.sys.fileExists : undefined,
        readFile: compiler.sys ? compiler.sys.readFile : undefined,
        readDirectory: compiler.sys ? compiler.sys.readDirectory : undefined,

        getCurrentDirectory,

        getCompilationSettings: () => compilerOptions,
        getDefaultLibFileName: (options: typescript.CompilerOptions) => compiler.getDefaultLibFilePath(options),
        getNewLine: () => newLine,
        log: log.log,

        /* Unclear if this is useful
        resolveTypeReferenceDirectives: (typeDirectiveNames: string[], containingFile: string) =>
            typeDirectiveNames.map(directive =>
                compiler.resolveTypeReferenceDirective(directive, containingFile, compilerOptions, moduleResolutionHost).resolvedTypeReferenceDirective),
        */

        resolveModuleNames: (moduleNames, containingFile) =>
            resolveModuleNames(
                resolveSync, moduleResolutionHost, appendTsSuffixTo, appendTsxSuffixTo, scriptRegex, instance,
                moduleNames, containingFile, resolutionStrategy),

        getCustomTransformers: () => instance.transformers
    };

    return servicesHost;
}

/**
 * Create the TypeScript Watch host
 */
export function makeWatchHost(
    scriptRegex: RegExp,
    log: logger.Logger,
    loader: Webpack,
    instance: TSInstance,
    appendTsSuffixTo: RegExp[],
    appendTsxSuffixTo: RegExp[]
) {
    const { compiler, compilerOptions, files, otherFiles } = instance;

    const newLine =
        compilerOptions.newLine === constants.CarriageReturnLineFeedCode ? constants.CarriageReturnLineFeed :
            compilerOptions.newLine === constants.LineFeedCode ? constants.LineFeed :
                constants.EOL;

    // make a (sync) resolver that follows webpack's rules
    const resolveSync = makeResolver(loader.options);

    const readFileWithFallback = compiler.sys === undefined || compiler.sys.readFile === undefined
        ? readFile
        : (path: string, encoding?: string | undefined): string | undefined => compiler.sys.readFile(path, encoding) || readFile(path, encoding);

    const moduleResolutionHost: ModuleResolutionHost = {
        fileExists,
        readFile: readFileWithFallback
    };

    // loader.context seems to work fine on Linux / Mac regardless causes problems for @types resolution on Windows for TypeScript < 2.3
    const getCurrentDirectory = (compiler!.version && semver.gte(compiler!.version, '2.3.0'))
        ? () => loader.context
        : () => process.cwd();

    const resolutionStrategy = (compiler!.version && semver.gte(compiler!.version, '2.4.0'))
        ? resolutionStrategyTS24AndAbove
        : resolutionStrategyTS23AndBelow;

    type WatchCallbacks<T> = { [fileName: string]: T[] | undefined };
    const watchedFiles: WatchCallbacks<typescript.FileWatcherCallback> = {};
    const watchedDirectories: WatchCallbacks<typescript.DirectoryWatcherCallback> = {};
    const watchedDirectoriesRecursive: WatchCallbacks<typescript.DirectoryWatcherCallback> = {};

    const watchHost: WatchHost = {
        rootFiles: getRootFileNames(),
        options: compilerOptions,

        useCaseSensitiveFileNames: () => compiler.sys.useCaseSensitiveFileNames,
        getNewLine: () => newLine,
        getCurrentDirectory,
        getDefaultLibFileName: options => compiler.getDefaultLibFilePath(options),

        fileExists,
        readFile: readFileWithCachingText,
        directoryExists: s => compiler.sys.directoryExists(path.normalize(s)),
        getDirectories: s => compiler.sys.getDirectories(path.normalize(s)),
        readDirectory: (s, extensions, exclude, include, depth) => compiler.sys.readDirectory(path.normalize(s), extensions, exclude, include, depth),
        realpath: s => compiler.sys.resolvePath(path.normalize(s)),
        trace: s => log.logInfo(s),

        watchFile,
        watchDirectory,

        resolveModuleNames: (moduleNames, containingFile) =>
            resolveModuleNames(
                resolveSync, moduleResolutionHost, appendTsSuffixTo, appendTsxSuffixTo, scriptRegex, instance,
                moduleNames, containingFile, resolutionStrategy),

        invokeFileWatcher,
        invokeDirectoryWatcher,
        updateRootFileNames: () => {
            instance.changedFilesList = false;
            if (instance.watchOfFilesAndCompilerOptions) {
                instance.watchOfFilesAndCompilerOptions.updateRootFileNames(getRootFileNames());
            }
        },
        createProgram: compiler.createAbstractBuilder
    };
    return watchHost;

    function getRootFileNames() {
        return Object.keys(files).filter(filePath => filePath.match(scriptRegex));
    }

    function readFileWithCachingText(fileName: string, encoding?: string) {
        fileName = path.normalize(fileName);
        let file = files[fileName] || otherFiles[fileName];
        if (file !== undefined) {
            return file.text;
        }
        const text = readFileWithFallback(fileName, encoding);
        if (text === undefined) { return undefined; }
        otherFiles[fileName] = { version: 0, text };
        return text;
    }

    function fileExists(s: string) {
        s = path.normalize(s);
        return !!files.hasOwnProperty(s) || compiler.sys.fileExists(s);
    }

    function invokeWatcherCallbacks(callbacks: typescript.FileWatcherCallback[] | undefined, fileName: string, eventKind: typescript.FileWatcherEventKind): void;
    function invokeWatcherCallbacks(callbacks: typescript.DirectoryWatcherCallback[] | undefined, fileName: string): void;
    function invokeWatcherCallbacks(callbacks: typescript.FileWatcherCallback[] | typescript.DirectoryWatcherCallback[] | undefined, fileName: string, eventKind?: typescript.FileWatcherEventKind) {
        if (callbacks) {
            // The array copy is made to ensure that even if one of the callback removes the callbacks,
            // we dont miss any callbacks following it
            const cbs = callbacks.slice();
            for (const cb of cbs) {
                cb(fileName, eventKind as typescript.FileWatcherEventKind);
            }
        }
    }

    function invokeFileWatcher(fileName: string, eventKind: typescript.FileWatcherEventKind) {
        fileName = path.normalize(fileName);
        invokeWatcherCallbacks(watchedFiles[fileName], fileName, eventKind);
    }

    function invokeDirectoryWatcher(directory: string, fileAddedOrRemoved: string) {
        directory = path.normalize(directory);
        invokeWatcherCallbacks(watchedDirectories[directory], fileAddedOrRemoved);
        invokeRecursiveDirectoryWatcher(directory, fileAddedOrRemoved);
    }

    function invokeRecursiveDirectoryWatcher(directory: string, fileAddedOrRemoved: string) {
        directory = path.normalize(directory);
        invokeWatcherCallbacks(watchedDirectoriesRecursive[directory], fileAddedOrRemoved);
        const basePath = path.dirname(directory);
        if (directory !== basePath) {
            invokeRecursiveDirectoryWatcher(basePath, fileAddedOrRemoved);
        }
    }

    function createWatcher<T>(file: string, callbacks: WatchCallbacks<T>, callback: T): typescript.FileWatcher {
        file = path.normalize(file);
        const existing = callbacks[file];
        if (existing) {
            existing.push(callback);
        }
        else {
            callbacks[file] = [callback];
        }
        return {
            close: () => {
                const existing = callbacks[file];
                if (existing) {
                    unorderedRemoveItem(existing, callback);
                }
            }
        };
    }

    function watchFile(fileName: string, callback: typescript.FileWatcherCallback, _pollingInterval?: number) {
        return createWatcher(fileName, watchedFiles, callback);
    }

    function watchDirectory(fileName: string, callback: typescript.DirectoryWatcherCallback, recursive?: boolean) {
        return createWatcher(fileName, recursive ? watchedDirectoriesRecursive : watchedDirectories, callback);
    }
}

function resolveModuleNames(
    resolveSync: ResolveSync,
    moduleResolutionHost: ModuleResolutionHost,
    appendTsSuffixTo: RegExp[],
    appendTsxSuffixTo: RegExp[],
    scriptRegex: RegExp,
    instance: TSInstance,
    moduleNames: string[],
    containingFile: string,
    resolutionStrategy: ResolutionStrategy
) {
    const resolvedModules = moduleNames.map(moduleName =>
        resolveModuleName(resolveSync, moduleResolutionHost, appendTsSuffixTo, appendTsxSuffixTo, scriptRegex, instance,
            moduleName, containingFile, resolutionStrategy));

    populateDependencyGraphs(resolvedModules, instance, containingFile);

    return resolvedModules;
}

function isJsImplementationOfTypings(
    resolvedModule: ResolvedModule,
    tsResolution: ResolvedModule
) {
    return resolvedModule.resolvedFileName.endsWith('js') &&
        /\.d\.ts$/.test(tsResolution.resolvedFileName);
}

type ResolutionStrategy = (resolutionResult: ResolvedModule | undefined, tsResolutionResult: ResolvedModule) => ResolvedModule;

function resolveModuleName(
    resolveSync: ResolveSync,
    moduleResolutionHost: ModuleResolutionHost,
    appendTsSuffixTo: RegExp[],
    appendTsxSuffixTo: RegExp[],
    scriptRegex: RegExp,
    instance: TSInstance,

    moduleName: string,
    containingFile: string,

    resolutionStrategy: ResolutionStrategy
) {
    const { compiler, compilerOptions } = instance;

    let resolutionResult: ResolvedModule;

    try {
        const originalFileName = resolveSync(undefined, path.normalize(path.dirname(containingFile)), moduleName);

        const resolvedFileName = appendTsSuffixTo.length > 0 || appendTsxSuffixTo.length > 0
            ? appendSuffixesIfMatch({
                '.ts': appendTsSuffixTo,
                '.tsx': appendTsxSuffixTo,
            }, originalFileName)
            : originalFileName;

        if (resolvedFileName.match(scriptRegex)) {
            resolutionResult = { resolvedFileName, originalFileName };
        }
    } catch (e) { }

    const tsResolution = compiler.resolveModuleName(moduleName, containingFile, compilerOptions, moduleResolutionHost);

    if (tsResolution.resolvedModule !== undefined) {
        const resolvedFileName = path.normalize(tsResolution.resolvedModule.resolvedFileName);
        const tsResolutionResult: ResolvedModule = {
            originalFileName: resolvedFileName,
            resolvedFileName,
            isExternalLibraryImport: tsResolution.resolvedModule.isExternalLibraryImport
        };

        return resolutionStrategy(resolutionResult!, tsResolutionResult);
    }
    return resolutionResult!;
}

function resolutionStrategyTS23AndBelow(resolutionResult: ResolvedModule | undefined, tsResolutionResult: ResolvedModule): ResolvedModule {
    if (resolutionResult! !== undefined) {
        if (resolutionResult!.resolvedFileName === tsResolutionResult.resolvedFileName ||
            isJsImplementationOfTypings(resolutionResult!, tsResolutionResult)) {
            resolutionResult!.isExternalLibraryImport = tsResolutionResult.isExternalLibraryImport;
        }
    } else {
        return tsResolutionResult;
    }
    return resolutionResult!;
}

function resolutionStrategyTS24AndAbove(resolutionResult: ResolvedModule | undefined, tsResolutionResult: ResolvedModule): ResolvedModule {
    return (resolutionResult! === undefined ||
        resolutionResult!.resolvedFileName === tsResolutionResult.resolvedFileName ||
        isJsImplementationOfTypings(resolutionResult!, tsResolutionResult)
    )
        ? tsResolutionResult
        : resolutionResult!;
}

function populateDependencyGraphs(
    resolvedModules: ResolvedModule[],
    instance: TSInstance,
    containingFile: string
) {
    resolvedModules = resolvedModules
        .filter(mod => mod !== null && mod !== undefined);

    instance.dependencyGraph[path.normalize(containingFile)] = resolvedModules;

    resolvedModules.forEach(resolvedModule => {
        if (instance.reverseDependencyGraph[resolvedModule.resolvedFileName] === undefined) {
            instance.reverseDependencyGraph[resolvedModule.resolvedFileName] = {};
        }
        instance.reverseDependencyGraph[resolvedModule.resolvedFileName]![path.normalize(containingFile)] = true;
    });
}
