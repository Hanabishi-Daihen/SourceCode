/**
 * Schematic Checker — Google Apps Script web app.
 *
 * The whole check runs in the user's browser (pdf.js + the checker scripts); this
 * server side only serves the page and, on request, saves results to the user's
 * Google Drive / Sheets.
 */

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('ตรวจสอบ Schematic')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Inline another project file into the page (used by Index.html). */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Create a Google Sheet in the user's Drive with the findings; returns its URL. */
function saveReportToSheet(title, rows) {
  var ss = SpreadsheetApp.create(String(title).slice(0, 200));
  var sheet = ss.getActiveSheet();
  sheet.setName('ผลตรวจ');
  if (rows && rows.length) {
    sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    sheet.getRange(1, 1, 1, rows[0].length).setFontWeight('bold').setBackground('#e8eefb');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(6, 520);
    sheet.setColumnWidth(7, 320);
    sheet.getRange(2, 6, Math.max(rows.length - 1, 1), 2).setWrap(true);
    for (var r = 2; r <= rows.length; r++) {
      if (rows[r - 1][1] === 'ผิดพลาด') sheet.getRange(r, 2).setFontColor('#c62828');
      else sheet.getRange(r, 2).setFontColor('#b26a00');
    }
  }
  return ss.getUrl();
}

/** Save the highlighted PDF (base64) to the user's Drive; returns its URL. */
function savePdfToDrive(name, base64) {
  var blob = Utilities.newBlob(Utilities.base64Decode(base64), 'application/pdf', String(name).slice(0, 200));
  return DriveApp.createFile(blob).getUrl();
}
