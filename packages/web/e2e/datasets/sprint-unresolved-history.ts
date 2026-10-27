import { legacyNameOnlySprintFixture } from "../../../core/test/fixtures/sprint";
import type { Dataset } from "../support/dataset";
import { loadLegacySprintDataset } from "../support/legacy-sprint-dataset";

const dataset: Dataset = (ctx) => loadLegacySprintDataset(ctx, undefined, (path) => legacyNameOnlySprintFixture(path, true));
export default dataset;
