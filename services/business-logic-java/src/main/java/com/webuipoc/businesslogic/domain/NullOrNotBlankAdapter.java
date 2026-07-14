package com.webuipoc.businesslogic.domain;

import io.avaje.validation.adapter.AbstractConstraintAdapter;
import io.avaje.validation.adapter.ConstraintAdapter;
import io.avaje.validation.adapter.ValidationContext;

/**
 * avaje-validator adapter for {@link NullOrNotBlank}: passes {@code null}
 * (field not provided) and any value with a non-whitespace character, rejects a
 * value that is entirely whitespace.
 */
@ConstraintAdapter(NullOrNotBlank.class)
public final class NullOrNotBlankAdapter extends AbstractConstraintAdapter<String> {

    public NullOrNotBlankAdapter(ValidationContext.AdapterCreateRequest request) {
        super(request);
    }

    @Override
    protected boolean isValid(String value) {
        return value == null || !value.strip().isEmpty();
    }
}
