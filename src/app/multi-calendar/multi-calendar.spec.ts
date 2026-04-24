import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MultiCalendar } from './multi-calendar';

describe('MultiCalendar', () => {
  let component: MultiCalendar;
  let fixture: ComponentFixture<MultiCalendar>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MultiCalendar]
    })
    .compileComponents();

    fixture = TestBed.createComponent(MultiCalendar);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
