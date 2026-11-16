import React from 'react';
import {Composition} from 'remotion';
import {DEFAULT_STYLE, dimensions, FPS, totalFrames, type AutoCutProps} from '../shared/types';
import {AutoCut} from './AutoCut';

const defaultProps: AutoCutProps = {
  format: 'landscape', clips: [], subtitles: [], markers: [], sourceAspect: 16 / 9, fit: 'cover', fx: 1,
  theme: DEFAULT_STYLE,
};

export const Root: React.FC = () => (
  <Composition
    id="AutoCut"
    component={AutoCut}
    fps={FPS}
    width={1920}
    height={1080}
    durationInFrames={1}
    defaultProps={defaultProps}
    calculateMetadata={({props}) => ({
      ...dimensions(props.format),
      durationInFrames: totalFrames(props),
    })}
  />
);
