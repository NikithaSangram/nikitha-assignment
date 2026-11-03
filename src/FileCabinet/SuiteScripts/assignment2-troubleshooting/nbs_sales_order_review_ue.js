/**
 * Reviews Sales Orders for a high total, a projected customer balance over the
 * credit limit, or a missing customer PO number. It records review reasons in
 * the standard Memo field and creates a linked follow-up Task for the user
 * saving the order.
 * Expected: flagged orders contain a review note and have a follow-up Task.
 * The review threshold is expressed in the account's base currency.
 *
 * There are possibly 4 hidden findings that could trigger unexpected result.
 * Try your best to find them and fix them.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/runtime', 'N/search', 'N/log'], (record, runtime, search, log) => {
    const REVIEW_MARKER = 'ORDER REVIEW REQUIRED';

    // Raise the review when it hits above the threshold amount in base currency.
    const REVIEW_THRESHOLD_BASE_CURRENCY = 10000;
    const PO_REQUIRED_MESSAGE = 'A customer PO number is required.';

    /** Updates the standard Memo field before save.
     * @param {Object} context User Event context.
     */
    const beforeSubmit = context => {
        if (!_isSupportedEvent(context.type)) return;
        const order = context.newRecord;
        const reasons = _getReviewReasons(_readOrderData(order));
        const memo = String(order.getValue({ fieldId: 'memo' }) || '').split(REVIEW_MARKER)[0].trim();
        const note = reasons.length ? `${REVIEW_MARKER}\n${reasons.join('\n')}` : '';
        order.setValue({ fieldId: 'memo', value: [memo, note].filter(Boolean).join('\n\n') });
    };

    /** Creates a review Task after the Sales Order is saved.
     * @param {Object} context User Event context.
     */
    const afterSubmit = context => {
        if (!_isSupportedEvent(context.type)) return;
        const order = context.newRecord;
        const memo = String(order.getValue({ fieldId: 'memo' }) || '');
        if (!memo.includes(REVIEW_MARKER)) return;
        const reasons = memo.slice(memo.indexOf(REVIEW_MARKER) + REVIEW_MARKER.length).trim();
        const taskId = _createOrUpdateReviewTask(order, reasons);
        log.audit({ title: 'Sales Order review task created', details: { salesOrderId: order.id, taskId } });
    };

    /** Checks whether a User Event should run.
     * @param {string} eventType User Event type.
     * @returns {boolean} True for create, edit, or copy.
     */
    const _isSupportedEvent = eventType => ['create', 'edit', 'copy'].includes(eventType);

    /** Reads values used by the review checks.
     * @param {Object} order Sales Order record.
     * @returns {Object} Normalized order and customer values.
     */
    const _readOrderData = order => {
        const customerId = order.getValue({ fieldId: 'entity' });
        const credit = customerId
            ? search.lookupFields({ type: search.Type.CUSTOMER, id: customerId, columns: ['balance', 'creditlimit'] })
            : {};
        const total = Number(order.getValue({ fieldId: 'total' }));
        const exchangeRateValue = order.getValue({ fieldId: 'exchangerate' });
        const exchangeRate = exchangeRateValue === '' || exchangeRateValue === null
            ? 1
            : Number(exchangeRateValue);

        if (!Number.isFinite(total) || !Number.isFinite(exchangeRate) || exchangeRate <= 0) {
            throw new Error('Unable to determine the Sales Order total in account base currency.');
        }

        return {
            totalBaseCurrency: total * exchangeRate,
            poNumber: String(order.getValue({ fieldId: 'otherrefnum' }) || ''),
            balance: Number(credit.balance) || 0,
            creditLimit: Number(credit.creditlimit) || 0
        };
    };

    /** Returns manual-review reasons for an order.
     * @param {Object} data Order and customer values.
     * @returns {string[]} Review reasons.
     */
    const _getReviewReasons = data => {
        const reasons = [];
        const projectedBalance = data.balance + data.totalBaseCurrency;
        if (data.totalBaseCurrency > REVIEW_THRESHOLD_BASE_CURRENCY) {
            reasons.push(`Order total ${data.totalBaseCurrency.toFixed(2)} exceeds the review threshold ${REVIEW_THRESHOLD_BASE_CURRENCY}.`);
        }
        if (data.creditLimit > 0 && projectedBalance > data.creditLimit) {
            reasons.push(`Projected balance ${projectedBalance.toFixed(2)} exceeds the credit limit ${data.creditLimit}.`);
        }
        if (!data.poNumber.trim()) {
            reasons.push(PO_REQUIRED_MESSAGE);
        }
        return reasons;
    };
    /** Creates a task associated with the customer and Sales Order.
     * @param {Object} order Saved Sales Order.
     * @param {string} reasons Review reasons for the task.
     * @returns {number|string} Task internal ID.
     */
    const _createOrUpdateReviewTask = (order, reasons) => {
        const title = `Review Sales Order ${order.getValue({ fieldId: 'tranid' })}`;
        const existingTasks = search.create({
            type: search.Type.TASK,
            filters: [
                ['transaction.internalid', 'anyof', order.id],
                'AND', ['title', 'is', title]
            ],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });

        if (existingTasks.length > 0) {
            const existingTask = record.load({ type: record.Type.TASK, id: existingTasks[0].id });
            existingTask.setValue({ fieldId: 'message', value: reasons });
            existingTask.setValue({ fieldId: 'assigned', value: runtime.getCurrentUser().id });
            return existingTask.save({ enableSourcing: true, ignoreMandatoryFields: false });
        }

        const task = record.create({ type: record.Type.TASK });
        task.setValue({ fieldId: 'title', value: title });
        task.setValue({ fieldId: 'company', value: order.getValue({ fieldId: 'entity' }) });
        task.setValue({ fieldId: 'transaction', value: order.id });
        task.setValue({ fieldId: 'message', value: reasons });
        task.setValue({ fieldId: 'startdate', value: new Date() });
        task.setValue({ fieldId: 'assigned', value: runtime.getCurrentUser().id });
        return task.save({ enableSourcing: true, ignoreMandatoryFields: false });
    };

    return { beforeSubmit, afterSubmit };
});
