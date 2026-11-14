/** Hands OpenCV to the photo pipeline in Node tests (loaded with `require`, outside the test runner's ESM interop). */
import { createRequire } from 'node:module'
import { provideCv } from '../../../src/app/photo/pipeline/cv'

export function useOpenCv(): void {
  provideCv(createRequire(import.meta.url)('@techstark/opencv-js'))
}
