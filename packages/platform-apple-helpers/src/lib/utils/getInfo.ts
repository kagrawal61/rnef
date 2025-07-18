import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, RnefError, spawn, type SubprocessError } from '@rnef/tools';
import { XMLParser } from 'fast-xml-parser';
import type { Info, XcodeProjectInfo } from '../types/index.js';

function parseTargetList(json: string): Info | undefined {
  try {
    const info = JSON.parse(json);

    if ('project' in info) {
      return info.project;
    } else if ('workspace' in info) {
      return info.workspace;
    }

    return undefined;
  } catch (error) {
    throw new RnefError('Failed to parse target list', { cause: error });
  }
}

export async function getInfo(
  projectInfo: XcodeProjectInfo,
  sourceDir: string
): Promise<Info | undefined> {
  if (!projectInfo.isWorkspace) {
    try {
      const { stdout } = await spawn('xcodebuild', ['-list', '-json'], {
        cwd: sourceDir,
        stdio: 'pipe',
      });
      const info = parseTargetList(stdout);

      if (!info) {
        throw new RnefError('Failed to get Xcode project information');
      }

      return info;
    } catch (error) {
      throw new RnefError('Failed to get a target list.', {
        cause: error,
      });
    }
  }

  const xmlParser = new XMLParser({ ignoreAttributes: false });
  const xcworkspacedata = path.join(
    sourceDir,
    projectInfo.name,
    'contents.xcworkspacedata'
  );
  const workspace = fs.readFileSync(xcworkspacedata, { encoding: 'utf-8' });
  const fileRef = xmlParser.parse(workspace).Workspace.FileRef;
  const refs = Array.isArray(fileRef) ? fileRef : [fileRef];
  const locations = refs
    .map((ref) => ref['@_location'])
    .filter(
      (location: string) =>
        !location.endsWith('/Pods.xcodeproj') && // Ignore the project generated by CocoaPods
        location.endsWith('.xcodeproj') // only pass project files
    );

  let info: Info | undefined = undefined;

  for (const location of locations) {
    let stdout = '';
    try {
      const buildOutput = await spawn(
        'xcodebuild',
        ['-list', '-json', '-project', location.replace('group:', '')],
        { cwd: sourceDir, stdio: 'pipe' }
      );
      stdout = buildOutput.stdout;
      logger.debug(stdout);
      logger.debug(buildOutput.stderr);
    } catch (error) {
      throw new RnefError('Failed to get project info', {
        cause: (error as SubprocessError).stderr,
      });
    }
    const projectInfo = parseTargetList(stdout);
    if (!projectInfo) {
      continue;
    }

    const schemes = projectInfo.schemes;

    // If this is the first project, use it as the "main" project
    if (!info) {
      if (!Array.isArray(schemes)) {
        projectInfo.schemes = [];
      }
      info = projectInfo;
      continue;
    }

    if (!Array.isArray(info.schemes)) {
      throw new RnefError("This shouldn't happen since we set it earlier");
    }

    // For subsequent projects, merge schemes list
    if (Array.isArray(schemes) && schemes.length > 0) {
      info.schemes = info.schemes.concat(schemes);
    }
  }
  return info;
}
