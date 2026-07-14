package com.webuipoc.businesslogic.domain;

import io.avaje.validation.constraints.Constraint;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * Business-rule constraint: the annotated string is valid when it is either
 * {@code null} (field not provided) or non-blank after trimming. Used on
 * {@link UpdateTodo#title()}, where {@code null} legitimately means "leave the
 * title unchanged" but a provided blank title must be rejected.
 *
 * <p>{@code @Constraint} marks it as an avaje-validator constraint; the paired
 * {@link NullOrNotBlankAdapter} implements the check. A {@code String message()}
 * method is required by the generator.
 */
@Constraint
@Target({ElementType.RECORD_COMPONENT, ElementType.FIELD, ElementType.PARAMETER, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
public @interface NullOrNotBlank {

    String message() default "must not be blank";

    Class<?>[] groups() default {};
}
