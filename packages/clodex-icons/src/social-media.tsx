import type { SVGProps } from 'react';
import { Github } from 'lucide-react';

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

export const IconGithub = ({
  size = 18,
  width,
  height,
  children: _children,
  ...props
}: IconProps) => (
  <Github
    aria-hidden="true"
    data-icon="IconGithub"
    height={height ?? size}
    strokeWidth={1.8}
    width={width ?? size}
    {...props}
  />
);
