import type { Dataset } from "../support/dataset";
import { loadLegacySprintDataset } from "../support/legacy-sprint-dataset";

const dataset: Dataset = (ctx) => loadLegacySprintDataset(ctx, (old) => {
  old.exec(`INSERT INTO issues(id,workspace_id,number,title,status,created_by,created_at,updated_at)
    VALUES(4,2,2,'期間外の親','todo','me','2026-01-01','2026-01-01');
    UPDATE issues SET parent_id=4 WHERE id=2;
    UPDATE issues SET cycle_id=1,parent_id=1 WHERE id=3;
    INSERT INTO page_displays VALUES('cycle:1','{"showChildren":false}','2026-01-01');`);
});
export default dataset;
