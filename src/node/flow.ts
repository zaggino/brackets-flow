import * as fs from 'fs';
import * as path from 'path';
import * as log from './log';
import { CodeInspectionResult, CodeInspectionReport } from '../types';

export interface FlowResult {
  errors: Array<{
    level: string,
    message: Array<{
      path: string,
      type: string,
      descr: string,
      line: number,
      start: number
    }>
  }>;
};

const spawn = require('cross-spawn');
const FLOW_TIMEOUT = 3000;

function fileExists(fullPath: string): boolean {
  try {
    return fs.statSync(fullPath).isFile();
  } catch (err) {
    return false;
  }
}

function hasFlowConfig(projectRoot: string): boolean {
  return fileExists(path.join(projectRoot, '.flowconfig'));
}

function hasFlowBin(projectRoot: string): boolean {
  return fileExists(path.join(projectRoot, 'node_modules', '.bin', 'flow'));
}

function spawnWrapper(cmd: string, args: string[], opts: any, callback): void {

  const stdout = [];
  // const stderr = [];
  const child = spawn(cmd, args, opts);

  child.stdout.on('data', (data) => stdout.push(data));
  // child.stderr.on('data', data => stderr.push(data));

  child.once('close', (code: number) => {
    callback(null, Buffer.concat(stdout).toString());
  });

  child.once('error', (err: Error) => {
    log.error('spawn-error', err.stack);
    callback(err);
  });

  return child;
}

function createCodeInspectionReport(filePath: string, flowResult: FlowResult): CodeInspectionReport {
  const errors: CodeInspectionResult[] = [];

  flowResult.errors.forEach((flowError) => {

    const comments = flowError.message.filter((x) => x.type === 'Comment').map((x) => x.descr);

    flowError.message.forEach((flowMessage) => {
      const isForFilePath = path.resolve(filePath) === path.resolve(flowMessage.path);
      if (!isForFilePath) { return; }

      let message = flowMessage.descr;
      if (comments.length > 0) {
        message = comments.join(' ') + ': ' + message;
      }

      errors.push({
        type: flowError.level === 'error' ? 'problem_type_error' : 'problem_type_warning',
        message,
        pos: {
          line: flowMessage.line - 1,
          ch: flowMessage.start - 1
        }
      });
    });

  });

  return { errors };
}

const _getFlowResults: { [root: string]: Promise<FlowResult> } = {};
function getFlowResult(projectRoot: string): Promise<FlowResult> {
  if (_getFlowResults[projectRoot]) { return _getFlowResults[projectRoot]; }
  _getFlowResults[projectRoot] = new Promise((resolve, reject) => {

    const flowExecName = process.platform === 'win32' ? 'flow.cmd' : 'flow';
    const flowExecPath = path.resolve(projectRoot, 'node_modules', '.bin', flowExecName);
    let resolved = false;
    let timedOut = false;

    const timeoutID = setTimeout(() => {
      if (resolved || timedOut) { return; }
      timedOut = true;
      const err = new Error();
      err.name = 'TimeoutError';
      return reject(err);
    }, FLOW_TIMEOUT);

    spawnWrapper(flowExecPath, ['--show-all-errors', '--json'], { cwd: projectRoot }, (err: Error, result) => {
      if (resolved || timedOut) { return; }
      resolved = true;
      clearTimeout(timeoutID);

      if (err) {
        return reject(err);
      }
      try {
        return resolve(JSON.parse(result));
      } catch (err) {
        log.error('getFlowResult-parse-error', err.stack);
        return reject(err);
      }
    });

  }).then((res) => {
    _getFlowResults[projectRoot] = undefined;
    return res;
  }).catch((err) => {
    _getFlowResults[projectRoot] = undefined;
    throw err;
  });
  return _getFlowResults[projectRoot];
}

export function scanFileWithFlow(
  projectRoot: string, fullPath: string, callback: (err?: Error, result?: CodeInspectionReport) => void
) {

  if (!hasFlowConfig(projectRoot)) {
    return callback(null, { errors: [] });
  }

  if (!hasFlowBin(projectRoot)) {
    return callback(null, {
      errors: [{
        type: 'problem_type_error',
        message: `FlowError: Can't locate node_modules/.bin/flow in your project, please install flow-bin`,
        pos: { line: 0, ch: 0 }
      }]
    });
  }

  getFlowResult(projectRoot).then((res) => {

    callback(null, createCodeInspectionReport(fullPath, res));

  }).catch((err) => {

    if (err.name === 'TimeoutError') {
      return callback(null, {
        errors: [{
          type: 'problem_type_error',
          message: `FlowError: Timed out after waiting ${FLOW_TIMEOUT}ms`,
          pos: { line: 0, ch: 0 }
        }]
      });
    }

    callback(err);

  });

}
