import type { FC, ReactElement } from 'react';
import {
  CIRCLE_RADIUS,
  CIRCLE_STROKE_WIDTH,
  SWIMLANE_CURVE_RADIUS,
  SWIMLANE_HEIGHT,
  SWIMLANE_WIDTH,
  type HistoryGraphViewModel,
} from './gitHistoryGraph';

interface HistoryGraphSvgProps {
  viewModel: HistoryGraphViewModel;
}

const rowBackground = 'var(--git-history-row-bg, #1b1b1b)';

function laneX(index: number): number {
  return SWIMLANE_WIDTH / 2 + index * SWIMLANE_WIDTH;
}

function lanePath(inputIndex: number, outputIndex: number): string {
  const fromX = laneX(inputIndex);
  const toX = laneX(outputIndex);
  const centerY = SWIMLANE_HEIGHT / 2;
  if (inputIndex === outputIndex) {
    return `M ${fromX} 0 V ${SWIMLANE_HEIGHT}`;
  }

  return [
    `M ${fromX} 0`,
    `V ${centerY - SWIMLANE_CURVE_RADIUS}`,
    `C ${fromX} ${centerY} ${toX} ${centerY} ${toX} ${centerY + SWIMLANE_CURVE_RADIUS}`,
    `V ${SWIMLANE_HEIGHT}`,
  ].join(' ');
}

export const HistoryGraphSvg: FC<HistoryGraphSvgProps> = ({ viewModel }) => {
  const { commit, inputSwimlanes, outputSwimlanes, currentNode } = viewModel;
  const laneCount = Math.max(
    inputSwimlanes.length,
    outputSwimlanes.length,
    viewModel.currentSwimlaneIndex + 1,
    1,
  );
  const width = SWIMLANE_WIDTH * (laneCount + 1);
  const centerY = SWIMLANE_HEIGHT / 2;
  const circleX = laneX(viewModel.currentSwimlaneIndex);
  const isMerge = commit.parents.length > 1;
  const isHead = viewModel.kind === 'head';
  const isVirtual = viewModel.kind === 'incoming-changes' || viewModel.kind === 'outgoing-changes';
  const paths: ReactElement[] = [];

  const addPath = (key: string, d: string, color: string, dashed = false) => {
    paths.push(
      <path
        key={key}
        d={d}
        fill="none"
        stroke={color}
        strokeDasharray={dashed ? '3 3' : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />,
    );
  };

  inputSwimlanes.forEach((lane, inputIndex) => {
    if (inputIndex === viewModel.currentSwimlaneIndex && lane.id === commit.hash) return;
    const outputIndex = outputSwimlanes.findIndex((outputLane) => outputLane.id === lane.id);
    if (outputIndex < 0) return;
    addPath(
      `lane-${lane.id}-${inputIndex}-${outputIndex}`,
      lanePath(inputIndex, outputIndex),
      outputSwimlanes[outputIndex]?.color ?? lane.color,
    );
  });

  if (!viewModel.currentLaneStarted) {
    addPath(
      `current-in-${commit.hash}`,
      `M ${circleX} 0 V ${centerY - CIRCLE_RADIUS - 1}`,
      currentNode.color,
      isVirtual,
    );
  }

  const parents = Array.from(new Set(commit.parents.filter(Boolean)));
  parents.forEach((parent, parentIndex) => {
    const outputIndex = outputSwimlanes.findIndex((lane) => lane.id === parent);
    if (outputIndex < 0) return;
    const outputX = laneX(outputIndex);
    const color = outputSwimlanes[outputIndex]?.color ?? currentNode.color;
    const d = outputIndex === viewModel.currentSwimlaneIndex
      ? `M ${circleX} ${centerY + CIRCLE_RADIUS + 1} V ${SWIMLANE_HEIGHT}`
      : [
          `M ${circleX} ${centerY}`,
          `C ${circleX} ${centerY + SWIMLANE_CURVE_RADIUS} ${outputX} ${centerY + SWIMLANE_CURVE_RADIUS} ${outputX} ${SWIMLANE_HEIGHT}`,
        ].join(' ');
    addPath(`parent-${commit.hash}-${parent}-${parentIndex}`, d, color, isVirtual);
  });

  return (
    <svg
      aria-hidden="true"
      className="git-history-graph-svg"
      height={SWIMLANE_HEIGHT}
      viewBox={`0 0 ${width} ${SWIMLANE_HEIGHT}`}
      width={width}
    >
      {paths}
      {isHead && (
        <>
          <circle
            cx={circleX}
            cy={centerY}
            fill={rowBackground}
            r={CIRCLE_RADIUS + 2}
            stroke={currentNode.color}
            strokeWidth={CIRCLE_STROKE_WIDTH}
          />
          <circle
            cx={circleX}
            cy={centerY}
            fill={rowBackground}
            r={CIRCLE_RADIUS - 1}
            stroke={currentNode.color}
            strokeWidth="1.5"
          />
        </>
      )}
      {!isHead && isMerge && (
        <>
          <circle
            cx={circleX}
            cy={centerY}
            fill={rowBackground}
            r={CIRCLE_RADIUS + 1}
            stroke={currentNode.color}
            strokeWidth={CIRCLE_STROKE_WIDTH}
          />
          <circle cx={circleX} cy={centerY} fill={currentNode.color} r="2" />
        </>
      )}
      {!isHead && !isMerge && (
        <circle
          cx={circleX}
          cy={centerY}
          fill={isVirtual ? rowBackground : currentNode.color}
          r={CIRCLE_RADIUS}
          stroke={currentNode.color}
          strokeDasharray={isVirtual ? '3 3' : undefined}
          strokeWidth={isVirtual ? CIRCLE_STROKE_WIDTH : 1}
        />
      )}
    </svg>
  );
};
