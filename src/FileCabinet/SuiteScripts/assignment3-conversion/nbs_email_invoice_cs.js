/**
 * Selects or clears all invoice rows on the email-invoice Suitelet.
 *
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/currentRecord'], currentRecord => {
    const SUBLIST_ID = 'custpage_invoices';
    const FIELD_ID = 'custpage_select';

    /** Selects every invoice row in the Suitelet list. */
    const selectAllInvoices = () => setInvoiceSelection(true);

    /** Clears every invoice selection in the Suitelet list. */
    const clearInvoiceSelection = () => setInvoiceSelection(false);
    function pageInit(scriptContext) {

    }
    /** Sets the selection checkbox for every invoice row. */
    const setInvoiceSelection = selected => {
        const record = currentRecord.get();
        const lineCount = record.getLineCount({ sublistId: SUBLIST_ID });

        for (let line = 0; line < lineCount; line += 1) {
            record.selectLine({ sublistId: SUBLIST_ID, line });
            record.setCurrentSublistValue({
                sublistId: SUBLIST_ID,
                fieldId: FIELD_ID,
                value: selected
            });
            record.commitLine({ sublistId: SUBLIST_ID });
        }
    };

    return { pageInit,selectAllInvoices, clearInvoiceSelection };
});