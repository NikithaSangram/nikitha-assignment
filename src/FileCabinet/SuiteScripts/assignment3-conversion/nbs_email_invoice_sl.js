/**
 * Lists open invoices and emails a PDF for each selected invoice.
 * Customer email addresses are used as recipients, and balances are checked
 * again before an email is sent.
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/email', 'N/log', 'N/render', 'N/runtime', 'N/search', 'N/ui/serverWidget'],
    (email, log, render, runtime, search, serverWidget) => {
        const SUBLIST_ID = 'custpage_invoices';

        /**
         * Displays the open invoices and processes selected invoices on submit.
         * @param {Object} context Suitelet request and response context.
         */
        const onRequest = context => {
            const form = serverWidget.createForm({ title: 'Email Unpaid Invoices' });
            form.clientScriptModulePath = '/SuiteScripts/assignment3-conversion/nbs_email_invoice_cs.js';

            const intro = form.addField({
                id: 'custpage_intro',
                type: serverWidget.FieldType.INLINEHTML,
                label: ' '
            });
            intro.defaultValue = '<p>Select one or more open invoices to email a PDF copy to the customer.</p>';

            if (context.request.method === 'POST') {
                const result = form.addField({ 
                    id: 'custpage_result',
                    type: serverWidget.FieldType.INLINEHTML,
                    label: ' '
                });
                result.defaultValue = emailSelectedInvoices(context.request);
            }

            addInvoiceSublist(form);
            populateInvoiceSublist(form);
            form.addButton({ id: 'custpage_select_all', label: 'Select All', functionName: 'selectAllInvoices' });
            form.addButton({ id: 'custpage_clear_all', label: 'Clear Selection', functionName: 'clearInvoiceSelection' });
            form.addSubmitButton({ label: 'Email Selected Invoices' });
            context.response.writePage(form);
        };

        /** Adds the open-invoice results list to the Suitelet form. */
        const addInvoiceSublist = form => {
            const sublist = form.addSublist({
                id: SUBLIST_ID,
                type: serverWidget.SublistType.LIST,
                label: 'Open Invoices'
            });

            sublist.addField({ id: 'custpage_select', type: serverWidget.FieldType.CHECKBOX, label: 'Email PDF' });
            sublist.addField({ id: 'custpage_tranid', type: serverWidget.FieldType.TEXT, label: 'Invoice' });
            sublist.addField({ id: 'custpage_customer', type: serverWidget.FieldType.TEXT, label: 'Customer' });
            sublist.addField({ id: 'custpage_date', type: serverWidget.FieldType.DATE, label: 'Date' });
            sublist.addField({ id: 'custpage_remaining', type: serverWidget.FieldType.CURRENCY, label: 'Amount Remaining' });
            sublist.addField({ id: 'custpage_invoiceid', type: serverWidget.FieldType.TEXT, label: 'Invoice ID' })
                .updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        };

        /** Populates the form with all open invoices that have a remaining balance. */
        const populateInvoiceSublist = form => {
            const invoiceSearch = search.create({
                type: search.Type.INVOICE,
                filters: [
                    ['status', 'anyof', 'CustInvc:A'],
                    'AND', ['mainline', 'is', 'T'],
                    'AND', ['amountremaining', 'greaterthan', '0']
                ],
                columns: ['internalid', 'tranid', 'entity', 'trandate', 'amountremaining']
            });
            const pagedResults = invoiceSearch.runPaged({ pageSize: 1000 });
            let line = 0;

            pagedResults.pageRanges.forEach(pageRange => {
                const page = pagedResults.fetch({ index: pageRange.index });
                page.data.forEach(result => {
                    const values = {
                        custpage_tranid: result.getValue({ name: 'tranid' }),
                        custpage_customer: result.getText({ name: 'entity' }),
                        custpage_date: result.getValue({ name: 'trandate' }),
                        custpage_remaining: result.getValue({ name: 'amountremaining' }),
                        custpage_invoiceid: result.getValue({ name: 'internalid' })
                    };

                    Object.keys(values).forEach(fieldId => {
                        if (values[fieldId] !== null && values[fieldId] !== '') {
                            form.getSublist({ id: SUBLIST_ID }).setSublistValue({
                                id: fieldId,
                                line,
                                value: String(values[fieldId])
                            });
                        }
                    });
                    line += 1;
                });
            });
        };

        /** Emails a PDF for each selected invoice that is still open. */
        const emailSelectedInvoices = request => {
            log.debug({ title: 'Emailing selected invoices', details: `Request: ${request}` });
            const lineCount = request.getLineCount({ group: SUBLIST_ID });
            let sent = 0;
            const failures = [];
            log.debug({ title: 'Starting invoice email process', details: `Total invoices to process: ${lineCount}` });
            for (let line = 0; line < lineCount; line += 1) {
                log.debug({ title: `Processing invoice line: ${line}`, details: `Line number: ${request.getSublistValue({ group: SUBLIST_ID, name: 'custpage_select', line })}` });
                if (request.getSublistValue({ group: SUBLIST_ID, name: 'custpage_select', line }) !== 'T') {
                    continue;
                }

                const invoiceId = request.getSublistValue({ group: SUBLIST_ID, name: 'custpage_invoiceid', line });
                try {
                    emailInvoice(invoiceId);
                    sent += 1;
                } catch (error) {
                    const invoiceNumber = request.getSublistValue({ group: SUBLIST_ID, name: 'custpage_tranid', line });
                    const message = `${invoiceNumber || invoiceId}: ${error.message || String(error)}`;
                    failures.push(message);
                    log.error({ title: 'Invoice PDF email failed', details: message });
                }
            }

            if (sent === 0 && failures.length === 0) {
                return '<p>No invoices were selected.</p>';
            }

            let summary = `<p>Invoice PDFs emailed: ${sent}.</p>`;
            if (failures.length > 0) {
                summary += `<p>Not emailed:</p><ul>${failures.map(escapeHtml).map(message => `<li>${message}</li>`).join('')}</ul>`;
            }
            return summary;
        };

        /** Verifies an invoice is still unpaid and emails its PDF to the customer. */
        const emailInvoice = invoiceId => {
            let stage = 'validating invoice selection';
            try {
                log.debug({ title: 'Invoice email workflow started', details: `Invoice ID: ${invoiceId}` });
                if (!/^\d+$/.test(String(invoiceId || ''))) {
                    throw new Error('Invalid invoice selection.');
                }

                stage = 'checking invoice balance';
                const invoice = search.lookupFields({
                    type: search.Type.INVOICE,
                    id: invoiceId,
                    columns: ['amountremaining', 'entity', 'tranid']
                });
                const remaining = parseFloat(invoice.amountremaining);
                if (!(remaining > 0)) {
                    throw new Error('The invoice is no longer unpaid.');
                }

                const entity = Array.isArray(invoice.entity) ? invoice.entity[0] : invoice.entity;
                const customerId = entity && typeof entity === 'object' ? entity.value : entity;
                const invoiceNumber = invoice.tranid;
                const customer = customerId && search.lookupFields({
                    type: search.Type.CUSTOMER,
                    id: customerId,
                    columns: ['email']
                });
                const customerEmail = customer && customer.email;
                if (!customerEmail) {
                    throw new Error('The customer does not have an email address.');
                }

                stage = 'generating invoice PDF';
                log.debug({
                    title: 'Invoice PDF generation started',
                    details: `Invoice ID: ${invoiceId}; render.transaction; format: PDF`
                });
                const pdfFile = render.transaction({
                    entityId: Number(invoiceId),
                    printMode: render.PrintMode.PDF
                });
                log.debug({ title: 'Invoice PDF generated', details: `Invoice ID: ${invoiceId}` });
 
                stage = 'sending invoice email';
                log.debug({
                    title: 'Invoice email send started',
                    details: `Invoice ID: ${invoiceId}; Customer ID: ${customerId}; PDF attached: yes`
                });
                email.send({
                    author: runtime.getCurrentUser().id,
                    recipients: customerEmail,
                    subject: `Invoice ${invoiceNumber}`,
                    body: 'Please find the PDF copy of your invoice attached.',
                    relatedRecords: { transactionId: Number(invoiceId), entityId: Number(customerId) },
                    attachments: [pdfFile]
                });
                log.audit({
                    title: 'Invoice email send call completed',
                    details: `Invoice ID: ${invoiceId}; Customer ID: ${customerId}`
                });
            } catch (error) {
                let details = `Stage: ${stage}; Invoice ID: ${invoiceId}; Error: ${error.message || String(error)}`;
                if (error.name) details += `; Code: ${error.name}`;
                if (error.stack) details += `; Stack: ${error.stack}`;
                log.error({ title: 'Invoice email workflow failed', details });
                throw error;
            }
        };

        /** Escapes text before inserting it into Suitelet inline HTML. */
        const escapeHtml = value => String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');

        return { onRequest };
    });