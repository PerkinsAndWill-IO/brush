/**
 * Loads OpenCV in the photo worker. Import this (for its side effect) before running the pipeline there.
 * About 11 MB: only the photo worker may import this module.
 */
import cvModule from '@techstark/opencv-js'
import { provideCv } from './cv'

provideCv(cvModule)
