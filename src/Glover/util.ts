import * as Viewer from '../viewer';
import { vec3, mat4 } from 'gl-matrix';

export function subtractAngles(a: number, b: number): number {
    let diff = a - b;
    if (a <= -Math.PI || Math.PI < diff) {
        if (diff <= Math.PI) {
            return a - b + 2*Math.PI;
        } else {
            return a - b - 2*Math.PI;
        }
    } else {
        return diff;
    }
}

export function angularDistance(a: number, b: number): number {
  let diff = a - b;
  if (Math.abs(diff) > Math.PI) {
    if (b < a) {
      diff = b - a;
    }
    diff += 2*Math.PI;
  } else {
    if (diff <= 0.0) {
      diff = -diff;
    }
  }
  return diff;
}

export function radianModulo(theta: number): number {
    if (theta > 2*Math.PI) {
        theta -=  2*Math.PI;
    }
    if (theta < 0) {
        theta += 2*Math.PI;
    }
    return theta;
}

export function axisRotationToQuaternion(axis: [number, number, number], theta: number): [number, number, number, number] {
  let sinHalfTheta = Math.sin(theta / 2.0);
  return [
    Math.cos(theta / 2.0),
    axis[0] * sinHalfTheta,
    axis[1] * sinHalfTheta,
    axis[2] * sinHalfTheta,
  ];
}

export function lerp (start: number, end: number, t: number): number {
  return (1-t)*start + t*end;
}

export function radianLerp(dst: vec3, start: vec3, end: vec3, t: number) {
    for (let axis = 0; axis < 3; axis += 1) {
        let a = start[axis];
        let b = end[axis];
        if (b - a > Math.PI) {
            a += 2*Math.PI;
        } else if (a - b > Math.PI) {
            b += 2*Math.PI;
        }
        dst[axis] = a * (1-t) + b * t;
    }
}

let lookatScratch = vec3.create();
export function pushAlongLookatVector(dst: vec3, src: vec3, dist: number, viewerInput: Viewer.ViewerRenderInput) {
    mat4.getTranslation(lookatScratch, viewerInput.camera.worldMatrix);
    vec3.sub(lookatScratch, src, lookatScratch);
    vec3.normalize(lookatScratch, lookatScratch);
    vec3.scaleAndAdd(dst, src, lookatScratch, dist);
}

let rng_reg = 0x6151f;
export function random(max: number): number {
  if (max == 0) {
    return 0;
  } else {
    rng_reg ^= rng_reg << 1;
    if ((rng_reg & 0x80000000) != 0) {
        if (rng_reg === 0x80000000) {
            rng_reg = 0;
        }
    } else {
        rng_reg += 1;
    }
    return rng_reg % max;
  }
}

