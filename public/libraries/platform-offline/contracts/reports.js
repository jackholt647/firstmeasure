/* public/libraries/platform-offline/contracts/reports.js
 *
 * FirstMeasure report files without a connection (docs/architecture/offline.md, "Report files").
 *
 * An order's report PDFs, its model file and its picture are files, not JSON, so they are not saved reads. Declared
 * here they are kept like pictures: the network's answer when there is one, the device's copy when the server
 * cannot be reached, within the picture budget. The picture of every order a person looks at is kept this way as
 * it is shown. The PDFs are shown in a frame, which the worker does not see, so the Measurements app names them
 * for a project that is kept on the device (PlatformOffline.keepFiles) and shows the device's copy when offline.
 *
 * Nothing is queued here: ordering a report needs a connection.
 */
(function () {
  'use strict';
  const ORDER = '/v1/firstmeasure/projects/:order';

  FMOffline.contracts.add({
    id: 'reports',
    files: [
      'GET ' + ORDER + '/pdf',              // the stored report (?slot=main)
      'GET ' + ORDER + '/pdfs/report',
      'GET ' + ORDER + '/thumbnail',        // the order's picture in My Projects and the project window
      'GET ' + ORDER + '/artifacts/*'       // Summary.pdf, Report.pdf, model_data.xml
    ]
  });
})();
